import express from "express";
import dotenv from "dotenv";
import QRCode from "qrcode";
import os from "os";
import cors from "cors";

import { createCheckoutSession } from "./stripeService.js";
import { remoteStart, getTransactions, remoteStop } from "./citrineService.js";
import { registerSession, startBillingLoop } from "./billingService.js";
import { requestOTP, verifyOTP, authenticateToken } from "./authService.js";
import pool from "./db.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_PORT = process.env.FRONTEND_PORT || 3001;

// 🔹 Stripe webhook — MUST be registered BEFORE express.json()
// Stripe signature verification requires the raw request body.
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const stripe = (await import("./stripeService.js")).stripe;
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[Webhook] Signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const chargerId =
        session.metadata?.chargerId ||
        session.display_items?.[0]?.custom?.name ||
        "CHARGER123";
      const stripeCustomerId = session.customer || null;
      console.log(`[Webhook-Debug] session.completed for charger ${chargerId}, customer ${stripeCustomerId}`);

      // Retrieve the payment method used in this checkout and attach to customer
      let paymentMethodId = null;
      if (session.payment_intent && stripeCustomerId) {
        try {
          const stripe = (await import("./stripeService.js")).stripe;
          const pi = await stripe.paymentIntents.retrieve(session.payment_intent, {
            expand: ["payment_method"],
          });
          const pm = pi.payment_method;
          paymentMethodId = typeof pm === "string" ? pm : (pm?.id || null);
          console.log(`[Webhook] Payment success → charger: ${chargerId}, customer: ${stripeCustomerId}, pm: ${paymentMethodId}`);

          // Explicitly attach PM to customer so listPaymentMethods works too
          if (paymentMethodId) {
            try {
              await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
              console.log(`[Webhook] PM ${paymentMethodId} attached to customer ${stripeCustomerId}`);
            } catch (attachErr) {
              if (!attachErr.message?.includes("already been attached")) {
                console.error("[Webhook] PM attach error:", attachErr.message);
              }
            }
          }
        } catch (e) {
          console.error("[Webhook] Could not retrieve payment intent:", e.message);
        }
      } else {
        console.log(`[Webhook] Payment success → charger: ${chargerId}, customer: ${stripeCustomerId} (no PI)`);
      }

      // Store immediately with payment_method_id so billing doesn't need to list cards later
      await registerSession("pending_" + session.id, chargerId, session.id, null, stripeCustomerId, paymentMethodId);

      const idTag = process.env.OCPP_ID_TAG || "0123456789ABCD";
      remoteStart(chargerId, idTag)
        .then(result => {
          console.log(`[Webhook] remoteStart response for ${chargerId}:`, JSON.stringify(result));
          const transactionId = result?.transactionId;
          if (transactionId) {
            console.log(`[Webhook] Got transactionId ${transactionId} — linking checkout ${session.id}`);
            registerSession(transactionId, chargerId, session.id, null, stripeCustomerId, paymentMethodId);
          } else {
            console.log("[Webhook] remoteStart returned no transactionId — starting background poll");
            pollForTransactionId(chargerId, session.id, stripeCustomerId, paymentMethodId);
          }
        })
        .catch(err => {
          if (err.message.startsWith("OCPP_ERROR:")) {
            console.error(`[Webhook] remoteStart failed for ${chargerId} with OCPP error: ${err.message}. Skipping poll.`);
          } else {
            console.error("[Webhook] remoteStart error:", err.message);
          }
        });
    }

    res.json({ received: true });
  }
);

app.use(express.json());


// 🔹 Global Request Logger (Debug)
app.use((req, res, next) => {
  if (req.path !== "/favicon.ico") {
    console.log(`[Request] ${new Date().toISOString()} | ${req.method} ${req.originalUrl}`);
  }
  next();
});

app.use(cors({
  origin: [`http://localhost:${FRONTEND_PORT}`, `http://127.0.0.1:${FRONTEND_PORT}`],
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

// Serve static files (HTML, CSS, JS) from the 'public' folder (legacy)
app.use(express.static("public"));

/**
 * 🔹 Auth API: Request OTP (Cognito EMAIL_OTP or SMS_OTP)
 */
app.post("/api/auth/request-otp", async (req, res) => {
  const method = process.env.OTP_METHOD || 'email';
  const { email, phone } = req.body;
  console.log(`[Cognito-Debug] Requesting OTP. Method=${method}, Email=${email}, Phone=${phone}`);
  const identifier = method === 'sms' ? phone : email;

  if (!identifier) {
    return res.status(400).json({ error: `${method === 'sms' ? 'Phone' : 'Email'} is required` });
  }

  try {
    const result = await requestOTP(identifier);
    res.json({ success: true, message: `OTP sent to your ${method}`, session: result.session });
  } catch (err) {
    console.error("Auth request-otp error:", err.message);
    res.status(500).json({ error: "Failed to send OTP: " + err.message });
  }
});

/**
 * 🔹 Auth API: Verify OTP
 */
app.post("/api/auth/verify-otp", async (req, res) => {
  const method = process.env.OTP_METHOD || 'email';
  const { email, phone, otp, session } = req.body;
  const identifier = method === 'sms' ? phone : email;

  if (!identifier || !otp || !session) {
    return res.status(400).json({ error: "Identifier, OTP, and session are required" });
  }

  try {
    const result = await verifyOTP(identifier, otp, session);
    if (result.success) {
      res.json({ success: true, token: result.token, user: result.user });
    } else {
      res.status(401).json({ error: result.message });
    }
  } catch (err) {
    console.error("Auth verify-otp error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * 🔹 API: Get charger status
 */
app.get("/api/charger-status/:chargerId", async (req, res) => {
  const { chargerId } = req.params;
  try {
    // 1. Check our own sessions table first (it's immediate after remoteStart)
    // Look for recent active OR pending sessions (created in the last 10 mins)
    const [localRows] = await pool.execute(
      `SELECT transaction_id, status FROM sessions 
       WHERE LOWER(charger_id) = LOWER(?) 
       AND (
         status = 'active' OR 
         (status = 'pending' AND created_at > NOW() - INTERVAL 10 MINUTE)
       )
       ORDER BY created_at DESC LIMIT 1`,
      [chargerId]
    );

    if (localRows.length > 0) {
      const txId = localRows[0].transaction_id;
      const status = localRows[0].status;
      console.log(`[Status] Found ${status} session in local DB: ${txId} for charger ${chargerId}`);
      return res.json({
        chargerId,
        status: "Occupied",
        transactionId: txId.startsWith("pending_") ? null : txId,
      });
    }

    // 2. Fallback to Citrine GraphQL (slower/backup)
    console.log(`[Status] ${new Date().toISOString()} | No real ID in local DB for ${chargerId}, checking Citrine...`);
    const transactions = await getTransactions();

    // Find active transaction for this charger
    const cid = chargerId.toLowerCase().trim();
    const fiveMinsAgo = new Date(Date.now() - 5 * 60000);

    const activeTx = transactions.find(tx => {
      const sid = String(tx.stationId || "").toLowerCase().trim();

      // A session is active if:
      // 1. Citrine says isActive=true
      // 2. OR it has NO endTime and has a startTime
      // 3. OR it started in the last 5 minutes and hasn't ended (loosened check)
      const hasEnded = !!tx.endTime;
      const startedRecently = tx.startTime && new Date(tx.startTime) > fiveMinsAgo;
      const isActive = (tx.isActive === true || tx.isActive === "true" || (!hasEnded && (tx.startTime || startedRecently)));

      // Exact match or fuzzy match (e.g. "CHARGER_1" vs "1")
      const matches = sid === cid || sid.includes(cid) || cid.includes(sid);
      return matches && isActive;
    });

    if (!activeTx && transactions.length > 0) {
      const myTxs = transactions.filter(t => String(t.stationId || "").toLowerCase().trim().includes(cid));
      if (myTxs.length > 0) {
        const latest = myTxs[0];
        console.log(`[Status] Found ${myTxs.length} past sessions for ${chargerId}. Latest: ID=${latest.transactionId}, Active=${latest.isActive}, EndTime=${latest.endTime}`);
      }
      const allSids = [...new Set(transactions.map(t => t.stationId))].slice(0, 5);
      console.log(`[Status] No CURRENT match for ${chargerId} in Citrine. Top stationIds found: ${allSids.join(", ")}`);
    }

    res.json({
      chargerId,
      status: activeTx ? "Occupied" : "Available",
      transactionId: activeTx?.transactionId !== undefined ? activeTx.transactionId : null,
    });
  } catch (err) {
    console.error("Charger status check error:", err.message);
    res.status(500).json({ error: "Failed to fetch charger status" });
  }
});

/**
 * Helper to poll for a transaction ID in the background if remoteStart didn't return it
 */
async function pollForTransactionId(chargerId, checkoutId, customerId, paymentMethodId) {
  let transactionId = null;
  let attempts = 0;
  const maxAttempts = 30; // 30 * 4s = 120 seconds (background poll is now longer)
  console.log(`[Poll] Starting background poll for charger ${chargerId} (up to 120s)...`);

  while (!transactionId && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const transactions = await getTransactions();
      const cid = chargerId.toLowerCase().trim();
      const fiveMinsAgo = new Date(Date.now() - 5 * 60000);

      const tx = transactions.find(t => {
        const sid = String(t.stationId || "").toLowerCase().trim();
        const hasEnded = !!t.endTime;
        const startedRecently = t.startTime && new Date(t.startTime) > fiveMinsAgo;
        const isActive = (t.isActive === true || t.isActive === "true" || (!hasEnded && (t.startTime || startedRecently)));

        const matches = sid === cid || sid.includes(cid) || cid.includes(sid);
        return matches && isActive;
      });

      if (tx?.transactionId) {
        transactionId = tx.transactionId;
        console.log(`[Poll] SUCCESS: Found transactionId ${transactionId} for ${chargerId} on attempt ${attempts + 1}`);
        await registerSession(transactionId, chargerId, checkoutId, null, customerId, paymentMethodId);
      } else {
        console.log(`[Poll] Attempt ${attempts + 1}/${maxAttempts}: No active tx in ${transactions.length} records for ${chargerId}`);
      }
    } catch (e) {
      console.error(`[Poll] Error on attempt ${attempts + 1}:`, e.message);
    }
    attempts++;
  }
  if (!transactionId) {
    console.error(`[Poll] FAILED: Could not find transactionId for ${chargerId} after 120s.`);
  }
}


/**
 * 🔹 API: Get active session details
 */
app.get("/api/active-session/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  try {
    // 1. Check live transactions from Citrine
    const transactions = await getTransactions();
    const liveTx = transactions.find(t => t.transactionId === transactionId);

    if (liveTx) {
      return res.json({
        transactionId,
        stationId: liveTx.stationId,
        isActive: liveTx.isActive,
        startTime: liveTx.startTime,
        endTime: liveTx.endTime,
        totalKwh: liveTx.totalKwh || 0,
        totalCost: liveTx.totalCost || 0
      });
    }

    // 2. Fallback to Database for completed sessions
    const [rows] = await (await import("./db.js")).default.execute(
      "SELECT * FROM sessions WHERE transaction_id = ?",
      [transactionId]
    );
    const dbTx = rows[0];

    if (dbTx) {
      return res.json({
        transactionId: dbTx.transaction_id,
        stationId: dbTx.charger_id,
        isActive: dbTx.status !== 'completed',
        startTime: dbTx.start_time,
        endTime: dbTx.end_time,
        totalKwh: dbTx.kwh || 0,
        totalCost: dbTx.cost || 0
      });
    }

    res.status(404).json({ error: "Session not found" });
  } catch (err) {
    console.error("Fetch session error:", err.message);
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

/**
 * 🔹 API: Stop charging session
 */
app.get("/api/stop-charging/:chargerId/:transactionId", authenticateToken, async (req, res) => {
  const { chargerId, transactionId } = req.params;
  try {
    await remoteStop(chargerId, transactionId);
    res.json({ success: true, message: "Stop command sent" });
  } catch (err) {
    console.error("Stop charging error:", err.message);
    res.status(500).json({ error: "Failed to stop charging", details: err.message });
  }
});

/**
 * 🔹 API: Direct start for returning customers (skips Stripe Checkout)
 * Requires: ?email=... query param. Verifies saved card exists, then starts charging.
 */
app.get("/api/start-direct/:chargerId", authenticateToken, async (req, res) => {
  const { chargerId } = req.params;
  const customerEmail = req.query.email;
  console.log(`[DirectStart-Debug] Incoming request for charger ${chargerId}, email ${customerEmail}`);
  if (!customerEmail) return res.status(400).json({ error: "email required" });

  try {
    const { stripe } = await import("./stripeService.js");

    // Find existing Stripe customer
    const customers = await stripe.customers.list({ email: customerEmail, limit: 1 });
    if (!customers.data.length) {
      return res.json({ canDirect: false, reason: "No Stripe customer found" });
    }
    const customer = customers.data[0];

    // Check for a saved payment method (card or link)
    const [cardPms, linkPms] = await Promise.all([
      stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 1 }),
      stripe.paymentMethods.list({ customer: customer.id, type: "link", limit: 1 }),
    ]);
    const pm = cardPms.data[0] || linkPms.data[0];
    if (!pm) {
      return res.json({ canDirect: false, reason: "No saved payment method" });
    }

    // Register pending session immediately with customer + PM
    const pendingId = "pending_direct_" + Date.now();
    await registerSession(pendingId, chargerId, null, null, customer.id, pm.id);

    // Fire remoteStart async
    const idTag = process.env.OCPP_ID_TAG || "0123456789ABCD";
    console.log(`[DirectStart] Starting charger ${chargerId} for customer ${customer.id} (pm: ${pm.id})`);
    remoteStart(chargerId, idTag)
      .then(result => {
        console.log(`[DirectStart] remoteStart response for ${chargerId}:`, JSON.stringify(result));
        const transactionId = result?.transactionId;
        if (transactionId) {
          console.log(`[DirectStart] Got transactionId ${transactionId}`);
          registerSession(transactionId, chargerId, null, null, customer.id, pm.id);
        } else {
          console.log(`[DirectStart] No immediate transactionId — starting background poll`);
          pollForTransactionId(chargerId, null, customer.id, pm.id);
        }
      })
      .catch(err => {
        if (err.message.startsWith("OCPP_ERROR:")) {
          console.error(`[DirectStart] remoteStart failed for ${chargerId} with OCPP error: ${err.message}. Skipping poll.`);
        } else {
          console.error("[DirectStart] remoteStart error:", err.message);
        }
      });

    res.json({ canDirect: true });
  } catch (err) {
    console.error("Direct start error:", err.message);
    res.status(500).json({ error: "Failed to start direct charging" });
  }
});

/**
 * 🔹 API: Get final bill for a session (polls until billing is complete)
 */
app.get("/api/session-bill/:transactionId", authenticateToken, async (req, res) => {
  const { transactionId } = req.params;
  try {
    const pool = (await import("./db.js")).default;
    const [rows] = await pool.execute(
      "SELECT kwh, cost, final_charged, status FROM sessions WHERE transaction_id = ?",
      [transactionId]
    );
    if (!rows.length) return res.status(404).json({ error: "Session not found" });
    const s = rows[0];
    res.json({
      kwh: s.kwh || 0,
      cost: s.cost || 0,
      finalCharged: !!s.final_charged,
      status: s.status,
    });
  } catch (err) {
    console.error("Session bill error:", err.message);
    res.status(500).json({ error: "Failed to get session bill" });
  }
});

/**
 * 🔹 API: Generate QR code for a charger
 * Points to the Next.js frontend app (port 3001)
 */
app.get("/api/qr/:chargerId", async (req, res) => {
  const { chargerId } = req.params;
  console.log(`[QR-Gen] Request for charger: ${chargerId}`);

  const ip = getLocalIp();

  // QR points to the Next.js frontend, not the old public/index.html
  const landingPageUrl = `http://${ip}:${FRONTEND_PORT}/?chargerId=${chargerId}`;
  console.log(`[QR-Gen] Target URL: ${landingPageUrl}`);

  try {
    res.setHeader("Content-Type", "image/png");
    await QRCode.toFileStream(res, landingPageUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#ffffff"
      }
    });
    console.log(`[QR-Gen] Success`);
  } catch (err) {
    console.error(`[QR-Gen] Error:`, err.message);
    res.status(500).send("Failed to generate QR code: " + err.message);
  }
});

// Alias for easier access to QR generator
app.get("/qr-generator", (req, res) => {
  res.sendFile(process.cwd() + "/public/qr-generator.html");
});

/**
 * 🔹 API: Create Stripe Checkout session for a charger
 * Called by the Next.js frontend before starting a charge
 */
app.get("/api/checkout/:chargerId", authenticateToken, async (req, res) => {
  const { chargerId } = req.params;
  const customerEmail = req.query.email || null;
  console.log(`[Checkout-Debug] Requesting session for charger ${chargerId}, email ${customerEmail}`);
  const ip = getLocalIp();
  const frontendBase = `http://${ip}:${FRONTEND_PORT}`;

  try {
    const session = await createCheckoutSession(chargerId, frontendBase, customerEmail);
    res.json({ url: session.url });
  } catch (err) {
    console.error("[Checkout] Error:", err.message);
    res.status(500).json({ error: "Failed to create payment session" });
  }
});


/*
Create charging session (called by Next.js proxy after OTP verification)
*/
app.get("/create-session/:chargerId/:userIdTag", authenticateToken, async (req, res) => {
  const { chargerId, userIdTag } = req.params;
  console.log(`[Server] Received create-session request: Charger=${chargerId}, User=${userIdTag}`);
  startCharging(chargerId, userIdTag);
  res.json({ success: true, message: "Charging initiation sequence started" });
});



async function startCharging(chargerId, userIdTag) {
  console.log(`[Server] Starting charging sequence for ${chargerId} with user ${userIdTag}`);

  try {
    const res = await remoteStart(chargerId, userIdTag);

    if (res[0]?.success || res.status === 'Accepted') {
      console.log("Charging remote start command accepted!", res);
    } else {
      console.error("Failed to start charging:", res);
      return;
    }

    let transactionId = null;
    let attempts = 0;
    const maxAttempts = 12;

    while (!transactionId && attempts < maxAttempts) {
      console.log(`Polling for transaction ID (attempt ${attempts + 1}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, 3000));

      const transactions = await getTransactions();

      const latestTx = transactions
        .filter(tx => tx.stationId === chargerId && tx.isActive === true)
        .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];

      if (latestTx) {
        transactionId = latestTx.transactionId;
        console.log("Found Transaction ID:", transactionId);
      }
      attempts++;
    }

    if (transactionId) {
      console.log("Registering session in DB with ID:", transactionId);
      await registerSession(transactionId, chargerId, null, userIdTag);
    } else {
      console.error("Failed to retrieve transaction ID after polling.");
    }
  } catch (err) {
    console.error("Error in startCharging:", err.message);
  }
}


// 🔹 Stripe placeholder routes
app.get("/success", (req, res) => res.send("Payment Successful! You can return to your dashboard."));
app.get("/cancel", (req, res) => res.send("Payment Canceled."));

// 🔹 Prevent 404 for favicon
app.get("/favicon.ico", (req, res) => res.status(204).end());

// 🔹 Catch-all for any other routes (Handle 404)
app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).send("<h1>404 - Page Not Found</h1><p>The resource you are looking for does not exist.</p><a href='/index.html'>Go to Landing Page</a>");
    return;
  }
  res.status(404).json({ error: "Resource not found" });
});

/**
 * 🔹 Start system
 */
startBillingLoop();
app.listen(PORT, () =>
  console.log(`🚀 Express server running on http://localhost:${PORT}`)
);

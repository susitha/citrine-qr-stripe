import express from "express";
import dotenv from "dotenv";
import QRCode from "qrcode";
import os from "os";
import cors from "cors";

import { createCheckoutSession } from "./stripeService.js";
import { remoteStart, getTransactions, remoteStop } from "./citrineService.js";
import { registerSession, startBillingLoop } from "./billingService.js";
import { requestOTP, verifyOTP, authenticateToken } from "./authService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_PORT = process.env.FRONTEND_PORT || 3001;

app.use(express.json());

// Allow Next.js frontend to call the Express backend
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
    const transactions = await getTransactions();
    const activeTx = transactions.find(tx => tx.stationId === chargerId && tx.isActive === true);

    res.json({
      chargerId,
      status: activeTx ? "Occupied" : "Available",
      transactionId: activeTx?.transactionId || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch charger status" });
  }
});

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


/*
Create charging session (called by Next.js proxy after OTP verification)
*/
app.get("/create-session/:chargerId/:userIdTag", authenticateToken, async (req, res) => {
  const { chargerId, userIdTag } = req.params;
  console.log(`[Server] Received create-session request: Charger=${chargerId}, User=${userIdTag}`);
  startCharging(chargerId, userIdTag);
  res.json({ success: true, message: "Charging initiation sequence started" });
});


/*
Stripe webhook
*/
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
      return res.status(400).send(err.message);
    }

    /*
    When payment succeeds → start charger
    */
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const chargerId =
        session.display_items?.[0]?.custom?.name ||
        session.metadata?.chargerId ||
        "CHARGER123";

      console.log("Payment success → starting charger");

      const result = await remoteStart(chargerId);

      const transactionId = result.transactionId;

      registerSession(transactionId, chargerId, session.id);
    }

    res.json({ received: true });
  }
);

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

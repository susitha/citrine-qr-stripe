import dns from "dns";

// Force IPv4 globally for all Node.js network operations to bypass IPv6 DNS timeouts on macOS
const originalLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof options === "number") {
    options = { family: options };
  } else if (!options) {
    options = {};
  }
  if (options.family === undefined || options.family === 0) {
    options.family = 4;
  }
  return originalLookup.call(dns, hostname, options, callback);
};

import express from "express";
import dotenv from "dotenv";
import QRCode from "qrcode";
import os from "os";
import cors from "cors";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

import { registerSession, startBillingLoop } from "./billingService.js";
import { authenticateToken, getOrCreateIdTag } from "./authService.js";
import { remoteStart, getTransactions, remoteStop } from "./citrineService.js";
import { pollForTransactionId } from "./chargerService.js";
import { getLocalIp } from "./utils.js";
import pool from "./db.js";

// V1 Routers
import authRouter from "./routes/v1/authRouter.js";
import chargerRouter from "./routes/v1/chargerRouter.js";
import billingRouter from "./routes/v1/billingRouter.js";

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
      console.log(`[Webhook-Debug] session.completed for charger ${chargerId}, customer ${stripeCustomerId} (session: ${session.id})`);

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
      let idTag = session.metadata?.idTag;
      const customerEmail = session.metadata?.customerEmail;

      if (!idTag && customerEmail) {
        console.log(`[Webhook] idTag missing in metadata, attempting to resolve for ${customerEmail}`);
        idTag = await getOrCreateIdTag(customerEmail);
      }

      if (!idTag) {
        idTag = process.env.OCPP_ID_TAG || "0123456789ABCD";
      }

      await registerSession("pending_" + session.id, chargerId, session.id, idTag, stripeCustomerId, paymentMethodId);

      console.log(`[Webhook] Starting remoteStart for ${chargerId} with idTag: ${idTag}`);
      remoteStart(chargerId, idTag)
        .then(result => {
          console.log(`[Webhook] remoteStart response for ${chargerId}:`, JSON.stringify(result));
          const transactionId = result?.transactionId;
          if (transactionId) {
            console.log(`[Webhook] Got transactionId ${transactionId} — linking checkout ${session.id}`);
            registerSession(transactionId, chargerId, session.id, idTag, stripeCustomerId, paymentMethodId);
          } else {
            console.log("[Webhook] remoteStart returned no transactionId — starting background poll");
            pollForTransactionId(chargerId, session.id, stripeCustomerId, paymentMethodId, idTag);
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
    const timestamp = new Date().toISOString();
    console.log(`[Request] ${timestamp} | ${req.method} ${req.originalUrl}`);
    if (req.method === "POST" && req.path === "/webhook") {
      console.log(`[Webhook-Trace] Raw webhook hit detected at ${timestamp}`);
    }
  }
  next();
});

app.use(cors({
  origin: [`http://localhost:${FRONTEND_PORT}`, `http://127.0.0.1:${FRONTEND_PORT}`],
  methods: ["GET", "POST", "PATCH", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Citrine Charging API",
      version: "1.0.0",
      description: "API documentation for the Citrine QR Stripe charging platform",
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: "Development server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./routes/v1/*.js", "./server.js"], // Path to the API docs
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 🔹 V1 API Routes
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/charger", chargerRouter);
app.use("/api/v1/billing", billingRouter);


// Serve static files (HTML, CSS, JS) from the 'public' folder (legacy)
app.use(express.static("public"));

/**
 * 🔹 API: Get active session details (Legacy Support)
 */
app.get("/api/active-session/:transactionId", async (req, res) => {
  res.redirect(301, `/api/v1/charger/session/${req.params.transactionId}`);
});

/**
 * 🔹 API: Stop charging session (Legacy Support)
 */
app.get("/api/stop-charging/:chargerId/:transactionId", authenticateToken, async (req, res) => {
  res.redirect(301, `/api/v1/charger/stop?chargerId=${req.params.chargerId}&transactionId=${req.params.transactionId}`);
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
    // Ensure user has an ID Tag
    const idTag = req.user.idTag || await getOrCreateIdTag(req.user.email);
    req.user.idTag = idTag; // Update local obj for consistency

    const session = await createCheckoutSession(chargerId, frontendBase, customerEmail, idTag);

    // Register a pre-session so the charger looks Occupied while the user handles Stripe
    console.log(`[Checkout-Debug] Pre-registering session for ${chargerId} (session: ${session.id}, idTag: ${idTag})`);
    await registerSession("pending_pre_" + session.id, chargerId, session.id, idTag);

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
  const { chargerId, userIdTag: urlIdTag } = req.params;
  const idTag = req.user.idTag || await getOrCreateIdTag(req.user.email) || urlIdTag;
  console.log(`[Server] Received create-session request: Charger=${chargerId}, UserTag=${idTag} (from req.user: ${req.user.idTag}, from url: ${urlIdTag})`);
  startCharging(chargerId, idTag);
  res.json({ success: true, message: "Charging initiation sequence started" });
});





// 🔹 Stripe placeholder routes
app.get("/success", (req, res) => res.send("Payment Successful! You can return to your dashboard."));
app.get("/cancel", (req, res) => res.send("Payment Canceled."));


app.get("/checkout_redirect/success", (req, res) => {
  const chargerId = req.query.chargerId || "";
  const sessionId = req.query.session_id || "";

  const appURL =
    `ev-charge://checkout?status=success` +
    `&chargerId=${encodeURIComponent(chargerId)}` +
    `&session_id=${encodeURIComponent(sessionId)}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Returning to Electron America</title>
    <script>
      window.location.replace(${JSON.stringify(appURL)});
      setTimeout(function () {
        window.location.href = ${JSON.stringify(appURL)};
      }, 800);
    </script>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;">
    <div style="max-width:420px;padding:24px;border-radius:16px;background:#1c1c1e;text-align:center;">
      <h1>Payment successful</h1>
      <p>Returning to the app...</p>
      <p><a href="${appURL}" style="color:#ffd60a;">Open Electron America</a></p>
    </div>
  </body>
</html>`);
});

app.get("/checkout_redirect/cancel", (req, res) => {
  const chargerId = req.query.chargerId || "";

  const appURL =
    `ev-charge://checkout?status=canceled` +
    `&chargerId=${encodeURIComponent(chargerId)}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Returning to Electron America</title>
    <script>
      window.location.replace(${JSON.stringify(appURL)});
      setTimeout(function () {
        window.location.href = ${JSON.stringify(appURL)};
      }, 800);
    </script>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;">
    <div style="max-width:420px;padding:24px;border-radius:16px;background:#1c1c1e;text-align:center;">
      <h1>Checkout canceled</h1>
      <p>Returning to the app...</p>
      <p><a href="${appURL}" style="color:#ffd60a;">Open Electron America</a></p>
    </div>
  </body>
</html>`);
});

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



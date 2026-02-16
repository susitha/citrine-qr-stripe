import express from "express";
import dotenv from "dotenv";
import QRCode from "qrcode";
import os from "os";

import { createCheckoutSession } from "./stripeService.js";
import { remoteStart, getTransactions, remoteStop } from "./citrineService.js";
import { registerSession, startBillingLoop } from "./billingService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

// Serve static files (HTML, CSS, JS) from the 'public' folder
app.use(express.static("public"));

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
    const transactions = await getTransactions();
    const tx = transactions.find(t => t.transactionId === transactionId);

    if (!tx) return res.status(404).json({ error: "Session not found" });

    res.json({
      transactionId,
      stationId: tx.stationId,
      isActive: tx.isActive,
      startTime: tx.startTime,
      endTime: tx.endTime,
      totalKwh: tx.totalKwh || 0,
      totalCost: tx.totalCost || 0
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

/**
 * 🔹 API: Stop charging session
 */
app.get("/api/stop-charging/:chargerId/:transactionId", async (req, res) => {
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
 */
app.get("/api/qr/:chargerId", async (req, res) => {
  const { chargerId } = req.params;
  console.log(`[QR-Gen] Request for charger: ${chargerId}`);

  const protocol = req.protocol;
  const ip = getLocalIp();

  // The URL the QR code will point to (using LAN IP instead of localhost)
  const landingPageUrl = `${protocol}://${ip}:${PORT}/index.html?chargerId=${chargerId}`;
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

// Alias for easier access
app.get("/qr-generator", (req, res) => {
  res.sendFile(process.cwd() + "/public/qr-generator.html");
});


/*
Create QR checkout
*/
app.get("/create-session/:chargerId/:userIdTag", async (req, res) => {
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

    if (res[0]?.success) {
      console.log("Charging started successfully!", res);
    } else {
      console.error("Failed to start charging:", res);
      return;
    }

    let transactionId = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (!transactionId && attempts < maxAttempts) {
      console.log(`Polling for transaction ID (attempt ${attempts + 1}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

      const transactions = await getTransactions();
      console.log(`[Polling] Fetched ${transactions.length} transactions`);

      // Find latest active transaction for this charger
      // API returns 'stationId', 'isActive', 'startTime'
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
      console.log("TRN ID", transactionId);
      registerSession(transactionId, chargerId, null);
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
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);

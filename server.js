import express from "express";
import dotenv from "dotenv";

import { createCheckoutSession } from "./stripeService.js";
import { remoteStart, getTransactions } from "./citrineService.js";
import { registerSession, startBillingLoop } from "./billingService.js";

dotenv.config();

const app = express();
app.use(express.json());


/*
Create QR checkout
*/
app.get("/create-session/:chargerId/:userIdTag", async (req, res) => {
  //const session = await createCheckoutSession(req.params.chargerId);
  startCharging(req.params.chargerId, req.params.userIdTag);
  // res.json({
  //   checkoutUrl: session.url,
  // });
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
  //const result = await remoteStart(chargerId);


  const response = await fetch(
    `${process.env.CITRINE_SERVER}/ocpp/1.6/evdriver/remoteStartTransaction?identifier=${chargerId}&tenantId=1`,
    //`${process.env.CITRINE_SERVER}/api/ocpp/charging-stations/${chargerId}/actions/remote-start-transaction`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CITRINE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idTag: userIdTag,
        connectorId: 1
      })
    });

  if (response.ok) {
    const data = await response.json();
    console.log('Charging started successfully!', data);

    // Poll for transaction ID
    let transactionId = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (!transactionId && attempts < maxAttempts) {
      console.log(`Polling for transaction ID (attempt ${attempts + 1}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

      const transactions = await getTransactions();
      console.log("Transactions fetched:", JSON.stringify(transactions, null, 2));

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
      // registerSession(transactionId, chargerId, session.id);
    } else {
      console.error("Failed to retrieve transaction ID after polling.");
    }

  } else {
    console.error('Failed to start charging:', await response.text());
  }
}


/*
Start everything
*/
startBillingLoop();

app.listen(process.env.PORT, () =>
  console.log("🚀 Server running on port", process.env.PORT)
);

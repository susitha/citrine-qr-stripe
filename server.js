import express from "express";
import dotenv from "dotenv";

import { createCheckoutSession } from "./stripeService.js";
import { remoteStart } from "./citrineService.js";
import { registerSession, startBillingLoop } from "./billingService.js";

dotenv.config();

const app = express();
app.use(express.json());


/*
Create QR checkout
*/
app.get("/create-session/:chargerId", async (req, res) => {
  const session = await createCheckoutSession(req.params.chargerId);

  res.json({
    checkoutUrl: session.url,
  });
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


/*
Start everything
*/
startBillingLoop();

app.listen(process.env.PORT, () =>
  console.log("🚀 Server running on port", process.env.PORT)
);

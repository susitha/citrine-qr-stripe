import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import Stripe from 'stripe';

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3000;
const PRICE_PER_KWH = Number(process.env.PRICE_PER_KWH || 0.40);

/* =================================================
   MIDDLEWARE
================================================= */

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());

/* =================================================
   MEMORY STORE (replace with DB in production)
================================================= */

const activeSessions = new Map();
/*
chargerId -> {
  customerId,
  paymentMethodId
}
*/

/* =================================================
   1️⃣ QR PAGE
================================================= */

app.get('/qr/:chargerId/:userIdTag', async (req, res) => {
  const { chargerId, userIdTag } = req.params;

  const checkoutUrl = `${process.env.DOMAIN}/checkout/${chargerId}/${userIdTag}`;
  const qr = await QRCode.toDataURL(checkoutUrl);

  res.send(`
    <html>
      <body style="text-align:center;font-family:sans-serif">
        <h1>⚡ Scan to Start Charging</h1>
        <img src="${qr}" width="300"/>
        <p><a href="${checkoutUrl}">Tap here if mobile</a></p>
      </body>
    </html>
  `);
});

/* =================================================
   2️⃣ STRIPE CHECKOUT (SAVE CARD ONLY)
================================================= */

app.get('/checkout/:chargerId/:userIdTag', async (req, res) => {
  const { chargerId, userIdTag } = req.params;

  // const session = await stripe.checkout.sessions.create({
  //   mode: 'setup', // save card only
  //   customer_creation: 'always',
  //   currency: "usd",
  //   success_url: `${process.env.DOMAIN}/success?charger=${chargerId}`,
  //   cancel_url: `${process.env.DOMAIN}/cancel`,

  //   metadata: { chargerId, userIdTag }
  // });

  await fetch(
      `${process.env.CITRINE_SERVER}/ocpp/1.6/evdriver/remoteStartTransaction?identifier=${chargerId}&tenantId=1`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.CITRINE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          idTag: userIdTag,
          connectorId: 1
        })
      }
    );

 // res.redirect(303, session.url);
});

/* =================================================
   3️⃣ STRIPE WEBHOOK → START CHARGING
================================================= */

app.post('/webhook', async (req, res) => {
  console.log("🔥 Webhook received");

  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log("❌ Webhook verification failed:", err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { chargerId, userIdTag } = session.metadata;

    console.log(`💳 Card saved for ${chargerId}`);

    const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);

    activeSessions.set(chargerId, {
      customerId: session.customer,
      paymentMethodId: setupIntent.payment_method
    });

    /* START CHARGING */
    // await fetch(
    //   `${process.env.CITRINE_SERVER}/ocpp/1.6/evdriver/remoteStartTransaction?identifier=${chargerId}&tenantId=1`,
    //   {
    //     method: 'POST',
    //     headers: {
    //       Authorization: `Bearer ${process.env.CITRINE_API_KEY}`,
    //       'Content-Type': 'application/json'
    //     },
    //     body: JSON.stringify({
    //       idTag: userIdTag,
    //       connectorId: 1
    //     })
    //   }
    // );

    console.log("⚡ Charging started");
  }

  res.sendStatus(200);
});



/* =================================================
   4️⃣ STOP CHARGING ENDPOINT
================================================= */

app.post('/stop/:chargerId', async (req, res) => {
  const { chargerId } = req.params;

  await fetch(
    `${process.env.CITRINE_SERVER}/api/ocpp/charging-stations/${chargerId}/actions/remote-stop-transaction`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CITRINE_API_KEY}`
      }
    }
  );

  console.log(`🛑 Stop requested for ${chargerId}`);
  res.send("Stopping charger...");
});

/* =================================================
   5️⃣ BILLING LOOP (PER kWh)
================================================= */

async function checkFinishedTransactions() {
  try {
    const res = await fetch(
      `${process.env.CITRINE_SERVER}/data/transactions/transaction`,
      {
        headers: {
          Authorization: `Bearer ${process.env.CITRINE_API_KEY}`
        }
      }
    );
    console.log("Transactions response:", JSON.stringify(res));

    const transactions = await res.json();

    for (const tx of transactions) {
      if (!tx.meterStop) continue;

      const chargerId = tx.chargingStationId;

      if (!activeSessions.has(chargerId)) continue;

      const session = activeSessions.get(chargerId);

      const energyWh = tx.meterStop - tx.meterStart;
      const kwh = energyWh / 1000;
      const cost = kwh * PRICE_PER_KWH;

      console.log(`🔋 ${kwh.toFixed(2)} kWh → $${cost.toFixed(2)}`);

      // await stripe.paymentIntents.create({
      //   amount: Math.round(cost * 100),
      //   currency: 'usd',
      //   customer: session.customerId,
      //   payment_method: session.paymentMethodId,
      //   off_session: true,
      //   confirm: true
      // });

      //console.log("💰 Stripe charged");

      activeSessions.delete(chargerId);
    }
  } catch (err) {
    console.error("Billing error:", err.message);
  }
}

setInterval(checkFinishedTransactions, 15000);

/* =================================================
   6️⃣ PAGES
================================================= */

app.get('/success', (req, res) => {
  const charger = req.query.charger;

  res.send(`
    <h2>⚡ Charging Started</h2>
    <form method="POST" action="/stop/${charger}">
      <button style="padding:12px 25px;font-size:18px">
        Stop Charging
      </button>
    </form>
  `);
});

app.get('/cancel', (req, res) =>
  res.send('<h2>❌ Payment cancelled</h2>')
);

/* =================================================
   START SERVER
================================================= */

app.listen(PORT, () =>
  console.log(`🚀 Server running → http://localhost:${PORT}`)
);

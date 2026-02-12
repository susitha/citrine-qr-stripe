import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import Stripe from 'stripe';

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());

const {
  DOMAIN,
  CITRINE_SERVER,
  CITRINE_API_KEY,
  PRICE_PER_KWH = 0.30,
  PORT = 3000
} = process.env;



/* ======================================================
   🔹 Helper — call Citrine REST
====================================================== */
async function citrineFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${CITRINE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}



/* ======================================================
   🔹 Helper — GraphQL query latest completed transaction
====================================================== */
async function getLatestTransaction(chargerId) {
  const query = `
    query {
      transactions(
        filter: {
          chargingStationId: { eq: "${chargerId}" }
          status: { eq: COMPLETED }
        }
        sort: { startTimestamp: DESC }
        limit: 1
      ) {
        items {
          transactionId
          meterStart
          meterStop
          startTimestamp
          stopTimestamp
        }
      }
    }
  `;

  const res = await citrineFetch(`${CITRINE_SERVER}/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query })
  });

  const json = await res.json();

  return json?.data?.transactions?.items?.[0];
}



/* ======================================================
   🔹 1. Static QR per charger
====================================================== */
app.get('/qr/:chargerId', async (req, res) => {
  const { chargerId } = req.params;

  const url = `${DOMAIN}/checkout/${chargerId}`;
  const qr = await QRCode.toDataURL(url);

  res.send(`
    <html>
      <body style="text-align:center;font-family:sans-serif">
        <h2>Scan to Start Charging</h2>
        <img src="${qr}" />
      </body>
    </html>
  `);
});



/* ======================================================
   🔹 2. Stripe checkout (small deposit)
====================================================== */
app.get('/checkout/:chargerId', async (req, res) => {
  const { chargerId } = req.params;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],

    // small deposit or session fee
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `Charging session ${chargerId}` },
        unit_amount: 100 // $1 deposit
      },
      quantity: 1
    }],

    success_url: `${DOMAIN}/success?charger=${chargerId}`,
    cancel_url: `${DOMAIN}/cancel`,
    metadata: { chargerId }
  });

  res.redirect(303, session.url);
});



/* ======================================================
   🔹 3. Stripe webhook → start charging
====================================================== */
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(err);
    return res.sendStatus(400);
  }

  /* ================================
     Payment success → START CHARGING
  ================================= */
  if (event.type === 'checkout.session.completed') {
    const chargerId = event.data.object.metadata.chargerId;

    console.log(`Starting charger ${chargerId}`);

    await citrineFetch(
      `${CITRINE_SERVER}/ocpp/1.6/evdriver/remoteStartTransaction?identifier=${chargerId}&tenantId=1`,
      {
        method: 'POST',
        body: JSON.stringify({
          idTag: 'WEBPAY', // any tag your charger accepts
          connectorId: 1
        })
      }
    );
  }

  res.sendStatus(200);
});



/* ======================================================
   🔹 4. Stop + bill endpoint
   Call this when user presses stop or auto timeout
====================================================== */
app.post('/stop/:chargerId', async (req, res) => {
  const { chargerId } = req.params;

  console.log(`Stopping charger ${chargerId}`);

  /* ---- stop charger ---- */
  await citrineFetch(
    `${CITRINE_SERVER}/ocpp/1.6/evdriver/remoteStopTransaction?identifier=${chargerId}&tenantId=1`,
    {
      method: 'POST',
      body: JSON.stringify({
        connectorId: 1
      })
    }
  );

  /* ---- wait few sec for Citrine to finalize ---- */
  await new Promise(r => setTimeout(r, 4000));

  /* ---- get latest completed transaction ---- */
  const tx = await getLatestTransaction(chargerId);

  if (!tx) {
    return res.json({ error: 'Transaction not found yet' });
  }

  const kWh = (tx.meterStop - tx.meterStart) / 1000;
  const cost = kWh * PRICE_PER_KWH;

  console.log(`Energy: ${kWh.toFixed(2)} kWh  Cost: $${cost.toFixed(2)}`);

  /* ---- Stripe final charge ---- */
  await stripe.paymentIntents.create({
    amount: Math.round(cost * 100),
    currency: 'usd',
    description: `Charging ${chargerId} - ${kWh.toFixed(2)} kWh`
  });

  res.json({
    kWh,
    cost
  });
});



/* ====================================================== */
app.get('/success', (req, res) =>
  res.send('<h2>Payment received. Charging started.</h2>')
);

app.get('/cancel', (req, res) =>
  res.send('<h2>Payment canceled.</h2>')
);



app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);

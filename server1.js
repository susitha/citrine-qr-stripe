import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import Stripe from 'stripe';

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

// For webhook signature verification, raw body needed
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());

/**
 * 1️⃣ Generate QR code linking to Stripe checkout
 * Example: http://localhost:3000/qr/CHARGER123/USERTAG001
 */
app.get('/qr/:chargerId/:userIdTag', async (req, res) => {
  const { chargerId, userIdTag } = req.params;
  const checkoutUrl = `${process.env.DOMAIN}/checkout/${chargerId}/${userIdTag}`;
  const qrDataUrl = await QRCode.toDataURL(checkoutUrl);

  res.send(`
    <html>
      <body style="text-align:center;">
        <h1>Scan QR to Pay & Start Charging</h1>
        <img src="${qrDataUrl}" />
        <p>Or click <a href="${checkoutUrl}">here</a></p>
      </body>
    </html>
  `);
});

/**
 * 2️⃣ Redirect user to Stripe checkout
 */
app.get('/checkout/:chargerId/:userIdTag', async (req, res) => {
  const { chargerId, userIdTag } = req.params;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `Charging Session ${chargerId}` },
        unit_amount: 500, // $5 example
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${process.env.DOMAIN}/success?charger=${chargerId}&user=${userIdTag}`,
    cancel_url: `${process.env.DOMAIN}/cancel`,
    metadata: { chargerId, userIdTag },
  });

  res.redirect(303, session.url);
});

/**
 * 3️⃣ Stripe webhook to handle payment success
 */
app.post('/webhook', async (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { chargerId, userIdTag } = session.metadata;

    console.log(`Payment successful for charger ${chargerId}, starting transaction...`);

    // 4️⃣ Call Citrine RemoteStartTransaction
    try {
      // const response = await fetch(`${process.env.CITRINE_SERVER}/api/charging-stations/${chargerId}/remote-start`, {
      //   method: 'POST',
      //   headers: {
      //     'Authorization': `Bearer ${process.env.CITRINE_API_KEY}`,
      //     'Content-Type': 'application/json'
      //   },
      //   body: JSON.stringify({ idTag: userIdTag })
      // });

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

      
      if (response.ok) console.log('Charging started successfully!');
      else console.error('Failed to start charging:', await response.text());
    } catch (err) {
      console.error('Error calling Citrine API:', err);
    }
  }

  res.sendStatus(200);
});

/**
 * 5️⃣ Optional pages
 */
app.get('/success', (req, res) => res.send('<h1>Payment successful! Charging started.</h1>'));
app.get('/cancel', (req, res) => res.send('<h1>Payment canceled.</h1>'));

/**
 * Start server
 */
app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT}`));

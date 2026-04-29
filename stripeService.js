import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
Create Checkout (QR payment)
Saves the card for future off-session charges via setup_future_usage.
*/
export async function createCheckoutSession(chargerId, frontendBase, customerEmail, idTag = null, platform = "web") {
  const currency = process.env.CURRENCY || "usd";
  const backendBase = process.env.BACKEND_PUBLIC_URL || "http://localhost:3000";
  const webBase = frontendBase || process.env.FRONTEND_URL || "http://localhost:3001";

  const successURL = platform === "ios"
    ? `${backendBase}/checkout_redirect/success?chargerId=${encodeURIComponent(chargerId)}&session_id={CHECKOUT_SESSION_ID}`
    : `${webBase}/?chargerId=${encodeURIComponent(chargerId)}&paid=true&session_id={CHECKOUT_SESSION_ID}`;

  const cancelURL = platform === "ios"
    ? `${backendBase}/checkout_redirect/cancel?chargerId=${encodeURIComponent(chargerId)}`
    : `${webBase}/?chargerId=${encodeURIComponent(chargerId)}&cancelled=true`;

  let customer;
  if (customerEmail) {
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({ email: customerEmail });
    }
  }

  const sessionParams = {
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: `EV Charging - ${chargerId}` },
          unit_amount: 100,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      setup_future_usage: "off_session",
    },
    success_url: successURL,
    cancel_url: cancelURL,
    metadata: {
      chargerId,
      customerEmail: customerEmail || "",
      idTag: idTag || "",
    },
  };

  console.log(`[StripeService] Session URLs: success=${successURL}, cancel=${cancelURL}`);

  if (customer) {
    sessionParams.customer = customer.id;
  } else if (customerEmail) {
    sessionParams.customer_email = customerEmail;
  }

  return stripe.checkout.sessions.create(sessionParams);
}

/*
Final billing charge — off-session using the customer's saved card
*/
export async function chargeCustomer(amountInCents, customerId, paymentMethodId = null, metadata = {}) {
  const currency = process.env.CURRENCY || "usd";

  let pmId = paymentMethodId;
  if (!pmId) {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
      limit: 1,
    });

    if (!paymentMethods.data.length) {
      throw new Error(`No saved payment method for customer ${customerId}`);
    }

    pmId = paymentMethods.data[0].id;
  }

  return stripe.paymentIntents.create({
    amount: amountInCents,
    currency,
    customer: customerId,
    payment_method: pmId,
    payment_method_types: ["card", "link"],
    off_session: true,
    confirm: true,
    metadata,
  });
}
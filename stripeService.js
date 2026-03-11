import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
Create Checkout (QR payment)
Saves the card for future off-session charges via setup_future_usage.
*/
export async function createCheckoutSession(chargerId, frontendBase, customerEmail, idTag = null) {
  const currency = process.env.CURRENCY || "usd";
  const base = frontendBase || process.env.DOMAIN || "http://localhost:3001";

  // Find or create a Stripe Customer so the card is saved to them
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
          unit_amount: 100, // $1.00 holding fee
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      setup_future_usage: "off_session", // Save the card for later billing
    },
    success_url: `${base}/?chargerId=${chargerId}&paid=true`,
    cancel_url: `${base}/?chargerId=${chargerId}&cancelled=true`,
    metadata: { chargerId, customerEmail: customerEmail || "", idTag: idTag || "" },
  };

  console.log(`[StripeService] Session URLs: success=${sessionParams.success_url}, cancel=${sessionParams.cancel_url}`);

  if (customer) sessionParams.customer = customer.id;
  else if (customerEmail) sessionParams.customer_email = customerEmail;

  return stripe.checkout.sessions.create(sessionParams);
}

/*
Final billing charge — off-session using the customer's saved card
*/
export async function chargeCustomer(amountInCents, customerId, paymentMethodId = null, metadata = {}) {
  const currency = process.env.CURRENCY || "usd";

  // Use the explicit payment method if provided, otherwise list from customer
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

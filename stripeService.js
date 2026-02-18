import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
Create Checkout (QR payment)
*/
export async function createCheckoutSession(chargerId) {
  const currency = process.env.CURRENCY || "usd";
  return stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: currency,
          product_data: {
            name: `EV Charging - ${chargerId}`,
          },
          unit_amount: 100, // $1.00 holding fee
        },
        quantity: 1,
      },
    ],
    success_url: `${process.env.DOMAIN}/success`,
    cancel_url: `${process.env.DOMAIN}/cancel`,
    metadata: { chargerId }
  });
}

/*
Final billing charge
*/
export async function chargeCustomer(amountInCents, metadata = {}) {
  const currency = process.env.CURRENCY || "usd";
  return stripe.paymentIntents.create({
    amount: amountInCents,
    currency: currency,
    payment_method_types: ["card"],
    metadata,
    confirm: true, // Auto-confirm for simple demo
    off_session: true, // Important for background billing
  });
}

import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

export const stripe = new Stripe(process.env.STRIPE_SECRET);

/*
Create Checkout (QR payment)
*/
export async function createCheckoutSession(chargerId) {
  return stripe.checkout.sessions.create({
    mode: "payment",

    line_items: [
      {
        price_data: {
          currency: process.env.CURRENCY,
          product_data: {
            name: `EV Charging - ${chargerId}`,
          },
          unit_amount: 100, // small holding fee (1 unit)
        },
        quantity: 1,
      },
    ],

    success_url: "http://localhost:3000/success",
    cancel_url: "http://localhost:3000/cancel",
  });
}


/*
Final billing charge
*/
export async function chargeCustomer(amount, metadata = {}) {
  return stripe.paymentIntents.create({
    amount,
    currency: process.env.CURRENCY,
    payment_method_types: ["card"],
    metadata,
  });
}

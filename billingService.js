import dotenv from "dotenv";
import { getTransactions } from "./citrineService.js";
import { chargeCustomer } from "./stripeService.js";

dotenv.config();

const PRICE_PER_KWH = Number(process.env.PRICE_PER_KWH);

const activeSessions = new Map();

/*
Register new session
*/
export function registerSession(transactionId, chargerId, checkoutId) {
  activeSessions.set(transactionId, {
    chargerId,
    checkoutId,
  });

  console.log("Tracking session:", transactionId);
}


/*
Billing calculation
*/
async function bill(tx) {
  const session = activeSessions.get(tx.transactionId);

  const kWh = (tx.meterStop - tx.meterStart) / 1000;

  const amount = Math.round(kWh * PRICE_PER_KWH);

  console.log(`Billing ${kWh} kWh → ${amount}`);

  await chargeCustomer(amount, {
    chargerId: session.chargerId,
    transactionId: tx.transactionId,
    kWh,
  });

  activeSessions.delete(tx.transactionId);
}


/*
Check finished transactions
*/
async function checkFinishedTransactions() {
  try {
    const txs = await getTransactions();

    for (const tx of txs) {
      if (!activeSessions.has(tx.transactionId)) continue;

      if (tx.stopTime) {
        await bill(tx);
      }
    }
  } catch (e) {
    console.error("Billing error:", e.message);
  }
}


/*
Start polling loop
*/
export function startBillingLoop() {
  setInterval(checkFinishedTransactions, 15000);
}

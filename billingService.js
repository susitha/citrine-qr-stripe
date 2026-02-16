import dotenv from "dotenv";
import { getTransactions } from "./citrineService.js";
import { chargeCustomer } from "./stripeService.js";

dotenv.config();

const PRICE_PER_KWH = Number(process.env.PRICE_PER_KWH) || 0.30; // Default to 0.30 if not set

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
  if (!session) return;

  // Use totalKwh directly from API
  const kWh = Number(tx.totalKwh) || 0;
  const amount = Math.round(kWh * PRICE_PER_KWH);

  console.log(`[Billing] Transaction ${tx.transactionId} for Charger ${session.chargerId}`);
  console.log(`[Billing] Energy: ${kWh.toFixed(2)} kWh | Rate: ${PRICE_PER_KWH}/kWh`);
  console.log(`[Billing] Total Amount: ${amount}`);

  if (session.checkoutId) {
    console.log(`[Billing] Charging customer for checkout ${session.checkoutId}...`);
    try {
      await chargeCustomer(amount, {
        chargerId: session.chargerId,
        transactionId: tx.transactionId,
        kWh,
      });
      console.log(`[Billing] Success!`);
    } catch (err) {
      console.error(`[Billing] Failed to charge customer:`, err.message);
    }
  } else {
    console.log(`[Billing] Manual session (no checkoutId). Bill recorded but no payment system triggered.`);
  }

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

      if (tx.endTime) {
        await bill(tx);
      }
    }
  } catch (err) {
    console.error("Billing loop error:", err.message);
  }
}


/*
Start polling loop
*/
export function startBillingLoop() {
  setInterval(checkFinishedTransactions, 15000);
}

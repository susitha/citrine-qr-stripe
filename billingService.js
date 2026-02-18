import dotenv from "dotenv";
import pool from "./db.js";
import { getTransactions } from "./citrineService.js";
import { chargeCustomer } from "./stripeService.js";

dotenv.config();

const PRICE_PER_KWH = Number(process.env.PRICE_PER_KWH) || 0.30;

/*
Register new session (DB Persistence)
*/
export async function registerSession(transactionId, chargerId, checkoutId, userIdTag = null) {
  try {
    const [result] = await pool.execute(
      "INSERT INTO sessions (transaction_id, charger_id, checkout_id, user_id_tag, status) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), checkout_id = VALUES(checkout_id)",
      [transactionId, chargerId, checkoutId, userIdTag, checkoutId ? 'active' : 'pending']
    );
    console.log("Tracking session in DB:", transactionId);
  } catch (err) {
    console.error("Failed to register session in DB:", err.message);
  }
}

/*
Billing calculation
*/
async function bill(tx) {
  try {
    const [rows] = await pool.execute("SELECT * FROM sessions WHERE transaction_id = ?", [tx.transactionId]);
    const session = rows[0];
    if (!session) return;

    const kWh = Number(tx.totalKwh) || 0;
    const amount = Math.round(kWh * PRICE_PER_KWH * 100); // Amount in cents for Stripe

    console.log(`[Billing] Transaction ${tx.transactionId} for Charger ${session.charger_id}`);
    console.log(`[Billing] Energy: ${kWh.toFixed(2)} kWh | Rate: ${PRICE_PER_KWH}/kWh`);
    console.log(`[Billing] Total Amount: ${amount / 100}`);

    if (session.checkout_id) {
      console.log(`[Billing] Charging customer for checkout ${session.checkout_id}...`);
      try {
        await chargeCustomer(amount, {
          chargerId: session.charger_id,
          transactionId: tx.transactionId,
          kWh: kWh.toString(),
        });
        console.log(`[Billing] Success!`);
      } catch (err) {
        console.error(`[Billing] Failed to charge customer:`, err.message);
      }
    } else {
      console.log(`[Billing] Manual session (no checkoutId). Bill recorded but no payment system triggered.`);
    }

    // Update session status to completed
    await pool.execute(
      "UPDATE sessions SET status = 'completed', kwh = ?, cost = ?, end_time = ? WHERE transaction_id = ?",
      [kWh, amount / 100, tx.endTime, tx.transactionId]
    );

  } catch (err) {
    console.error("Billing calculation error:", err.message);
  }
}

/*
Check finished transactions
*/
async function checkFinishedTransactions() {
  try {
    const txs = await getTransactions();

    // Get active sessions from DB
    const [activeRows] = await pool.execute("SELECT transaction_id FROM sessions WHERE status != 'completed'");
    const activeTransactionIds = new Set(activeRows.map(row => row.transaction_id));

    for (const tx of txs) {
      if (!activeTransactionIds.has(tx.transactionId)) continue;

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

import dotenv from "dotenv";
import pool from "./db.js";
import { getTransactions } from "./citrineService.js";
import { chargeCustomer } from "./stripeService.js";

dotenv.config();

const PRICE_PER_KWH = Number(process.env.PRICE_PER_KWH) || 0.30;

/*
Register new session (DB Persistence)
*/
export async function registerSession(transactionId, chargerId, checkoutId, userIdTag = null, stripeCustomerId = null, paymentMethodId = null) {
  try {
    await pool.execute(
      `INSERT INTO sessions 
        (transaction_id, charger_id, checkout_id, user_id_tag, stripe_customer_id, payment_method_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         checkout_id = VALUES(checkout_id),
         stripe_customer_id = COALESCE(VALUES(stripe_customer_id), stripe_customer_id),
         payment_method_id = COALESCE(VALUES(payment_method_id), payment_method_id)`,
      [transactionId, chargerId, checkoutId, userIdTag, stripeCustomerId, paymentMethodId,
        checkoutId ? 'active' : 'pending']
    );
    console.log("Tracking session in DB:", transactionId);
  } catch (err) {
    console.error("Failed to register session in DB:", err.message);
  }
}

/*
Billing calculation — charges the saved card off-session for actual kWh used
*/
async function bill(tx) {
  try {
    const txId = String(tx.transactionId);
    const [rows] = await pool.execute(
      "SELECT * FROM sessions WHERE transaction_id = ?",
      [txId]
    );
    const session = rows[0];
    if (!session) return;

    if (session.final_charged) {
      console.log(`[Billing] Session ${txId} already charged. Cleaning up status.`);
      await pool.execute(
        "UPDATE sessions SET status = 'completed' WHERE transaction_id = ?",
        [txId]
      );
      return;
    }

    const kWh = Number(process.env.BILLING_TEST_KWH) || Number(tx.totalKwh) || 0;
    const amount = Math.round(kWh * PRICE_PER_KWH * 100);

    console.log(`[Billing] Transaction ${txId} | Charger ${session.charger_id}`);
    console.log(`[Billing] Energy: ${kWh.toFixed(2)} kWh | Rate: $${PRICE_PER_KWH}/kWh | Total: $${(amount / 100).toFixed(2)}`);

    let stripeCustomerId = session.stripe_customer_id;
    let paymentMethodId = session.payment_method_id;
    if ((!stripeCustomerId || !paymentMethodId) && session.checkout_id) {
      const [pendingRows] = await pool.execute(
        "SELECT stripe_customer_id, payment_method_id FROM sessions WHERE checkout_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1",
        [session.checkout_id]
      );
      stripeCustomerId = stripeCustomerId || pendingRows[0]?.stripe_customer_id || null;
      paymentMethodId = paymentMethodId || pendingRows[0]?.payment_method_id || null;
      if (stripeCustomerId) console.log(`[Billing] Resolved via checkout_id: customer=${stripeCustomerId}, pm=${paymentMethodId}`);
    }

    if (stripeCustomerId) {
      console.log(`[Billing] Charging customer ${stripeCustomerId} off-session (pm: ${paymentMethodId || 'list'})...`);
      try {
        if (amount > 0) {
          await chargeCustomer(amount, stripeCustomerId, paymentMethodId, {
            chargerId: session.charger_id,
            transactionId: txId,
            kWh: kWh.toString(),
          });
          console.log(`[Billing] Off-session charge successful.`);
        } else {
          console.log(`[Billing] Zero kWh — no charge needed.`);
        }
      } catch (err) {
        console.error(`[Billing] Failed to charge customer:`, err.message);
      }
    }

    await pool.execute(
      `UPDATE sessions SET status = 'completed', kwh = ?, cost = ?, end_time = ?, final_charged = TRUE
       WHERE transaction_id = ?`,
      [kWh, amount / 100, tx.endTime, txId]
    );

  } catch (err) {
    console.error("Billing calculation error:", err.message);
  }
}

/*
Check finished transactions & handle auto-linking
*/
async function checkFinishedTransactions() {
  try {
    const txs = await getTransactions();

    // 1. Fetch ALL existing transaction/pending sessions
    const [allRows] = await pool.execute(
      "SELECT transaction_id, status, charger_id, checkout_id, stripe_customer_id, payment_method_id, final_charged FROM sessions"
    );
    const existingIds = new Set(allRows.map(r => String(r.transaction_id)));

    // 2. Identify brand-new transactions for auto-linking
    const tenMinsAgo = new Date(Date.now() - 10 * 60000);
    const candidateTxs = txs.filter(tx => {
      const txId = String(tx.transactionId);
      if (existingIds.has(txId)) return false;
      return !tx.endTime || new Date(tx.endTime) > tenMinsAgo;
    });

    // 3. Find our own pending sessions that need a real ID
    const pendingRows = allRows.filter(r =>
      String(r.transaction_id).startsWith("pending_") && r.status !== 'completed'
    );

    // 4. Track all sessions currently in the "active/billable" state
    const realActive = allRows.filter(r =>
      !String(r.transaction_id).startsWith("pending_") && r.status !== 'completed' && !r.final_charged
    );

    // 5. Auto-link new transactions to pending rows
    const linkedPendingIds = new Set();
    for (const tx of candidateTxs) {
      const txId = String(tx.transactionId);
      const chargerId = String(tx.stationId);

      const pending = pendingRows.find(p =>
        String(p.charger_id).toLowerCase() === chargerId.toLowerCase() &&
        !linkedPendingIds.has(p.transaction_id)
      );
      if (!pending) continue;

      console.log(`[Billing] Linking tx ${txId} → pending ${pending.transaction_id}`);
      await registerSession(txId, tx.stationId, pending.checkout_id, null, pending.stripe_customer_id, pending.payment_method_id);

      realActive.push({
        transaction_id: txId,
        charger_id: tx.stationId,
        checkout_id: pending.checkout_id,
        stripe_customer_id: pending.stripe_customer_id,
        payment_method_id: pending.payment_method_id,
        final_charged: false
      });
      linkedPendingIds.add(pending.transaction_id);

      await pool.execute(
        "UPDATE sessions SET status = 'completed', final_charged = TRUE WHERE transaction_id = ?",
        [pending.transaction_id]
      );
    }

    // 6. Process billing for all active/real transactions
    if (realActive.length > 0) {
      for (const tx of txs) {
        const txId = String(tx.transactionId);
        const session = realActive.find(r => String(r.transaction_id) === txId);
        if (!session) continue;

        if (!tx.endTime) {
          // Still active — skip billing
          continue;
        }

        console.log(`[Billing] ${txId} completed — billing now`);
        await bill(tx);
      }
    }
  } catch (err) {
    console.error("Billing loop error:", err.message);
  }
}

export function startBillingLoop() {
  setInterval(checkFinishedTransactions, 5000);
}

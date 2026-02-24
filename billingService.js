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
      // Mark completed so it stops appearing in the billing loop
      await pool.execute(
        "UPDATE sessions SET status = 'completed' WHERE transaction_id = ?",
        [txId]
      );
      return;
    }

    const kWh = Number(process.env.BILLING_TEST_KWH) || Number(tx.totalKwh) || 0;  // TEST: set BILLING_TEST_KWH=1 in .env to simulate billing
    const amount = Math.round(kWh * PRICE_PER_KWH * 100);

    console.log(`[Billing] Transaction ${txId} | Charger ${session.charger_id}`);
    console.log(`[Billing] Energy: ${kWh.toFixed(2)} kWh | Rate: $${PRICE_PER_KWH}/kWh | Total: $${(amount / 100).toFixed(2)}`);

    // Resolve stripe_customer_id and payment_method_id
    // May be on the session directly OR on the pending_ row
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
    } else if (session.checkout_id) {
      console.log(`[Billing] No stripe_customer_id found — manual billing record only.`);
    } else {
      console.log(`[Billing] Manual session (no Stripe). Bill recorded only.`);
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
Check finished transactions
*/
async function checkFinishedTransactions() {
  try {
    const txs = await getTransactions();

    const [activeRows] = await pool.execute(
      "SELECT transaction_id, charger_id, checkout_id, stripe_customer_id, payment_method_id, final_charged FROM sessions WHERE status != 'completed' AND final_charged = FALSE"
    );

    // Separate real sessions from pending_ placeholders
    const realActive = activeRows.filter(r => !String(r.transaction_id).startsWith("pending_"));
    const pendingRows = activeRows.filter(r => String(r.transaction_id).startsWith("pending_"));

    // Auto-link: match most recent CitrineOS tx per charger to a pending_ row
    // Group txs by stationId, take highest transactionId (most recent)
    const latestTxByCharger = new Map();
    for (const tx of txs) {
      const existing = latestTxByCharger.get(tx.stationId);
      if (!existing || Number(tx.transactionId) > Number(existing.transactionId)) {
        latestTxByCharger.set(tx.stationId, tx);
      }
    }

    const linkedPendingIds = new Set(); // prevent one pending_ linking to multiple txs

    for (const tx of txs) {
      const txId = String(tx.transactionId);
      const alreadyRegistered = realActive.some(r => String(r.transaction_id) === txId);
      if (alreadyRegistered) continue;

      const pending = pendingRows.find(p =>
        p.charger_id === tx.stationId && !linkedPendingIds.has(p.transaction_id)
      );
      if (!pending) continue;

      // Only link the MOST RECENT transaction for this charger to the pending_ row
      const latestTx = latestTxByCharger.get(tx.stationId);
      if (String(tx.transactionId) !== String(latestTx?.transactionId)) continue;

      console.log(`[Billing] Linking tx ${txId} → checkout ${pending.checkout_id} (customer: ${pending.stripe_customer_id}, pm: ${pending.payment_method_id || 'none'})`);
      await registerSession(txId, tx.stationId, pending.checkout_id, null, pending.stripe_customer_id, pending.payment_method_id);
      realActive.push({ transaction_id: txId, charger_id: tx.stationId, checkout_id: pending.checkout_id, stripe_customer_id: pending.stripe_customer_id, payment_method_id: pending.payment_method_id, final_charged: false });
      linkedPendingIds.add(pending.transaction_id);

      // Mark the pending_ row as completed so it never re-matches
      await pool.execute(
        "UPDATE sessions SET status = 'completed', final_charged = TRUE WHERE transaction_id = ?",
        [pending.transaction_id]
      );
    }

    if (realActive.length === 0) return;

    console.log(`[Billing] Active sessions: ${realActive.map(r => r.transaction_id).join(", ")}`);

    const activeMap = new Map(realActive.map(row => [String(row.transaction_id), row]));

    for (const tx of txs) {
      const txId = String(tx.transactionId);
      if (!activeMap.has(txId)) continue;

      const dbRow = activeMap.get(txId);

      if (dbRow.final_charged) continue;

      if (!tx.endTime) {
        console.log(`[Billing] ${txId} still active — skipping`);
        continue;
      }

      console.log(`[Billing] ${txId} completed — billing now`);
      await bill(tx);
    }
  } catch (err) {
    console.error("Billing loop error:", err.message);
  }
}


/*
Start polling loop
*/
export function startBillingLoop() {
  setInterval(checkFinishedTransactions, 5000);
}

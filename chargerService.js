import { getTransactions, remoteStart } from "./citrineService.js";
import { registerSession } from "./billingService.js";
import pool from "./db.js";

/**
 * Background poller to find a newly started transaction for a charger
 */
export async function pollForTransactionId(chargerId, checkoutId, customerId, paymentMethodId, userIdTag = null) {
    let transactionId = null;
    let attempts = 0;
    const maxAttempts = 30; // 30 * 4s = 120 seconds
    console.log(`[Poll] Starting background poll for charger ${chargerId} (up to 120s)...`);

    while (!transactionId && attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 4000));
        try {
            const transactions = await getTransactions();
            const cid = chargerId.toLowerCase().trim();
            const fiveMinsAgo = new Date(Date.now() - 5 * 60000);

            const tx = transactions.find(t => {
                const sid = String(t.stationId || "").toLowerCase().trim();
                const hasEnded = !!t.endTime;
                const startedRecently = t.startTime && new Date(t.startTime) > fiveMinsAgo;
                const isActive = (t.isActive === true || t.isActive === "true" || (!hasEnded && (t.startTime || startedRecently)));

                const matches = sid === cid || sid.includes(cid) || cid.includes(sid);
                return matches && isActive;
            });

            if (tx?.transactionId) {
                transactionId = tx.transactionId;
                console.log(`[Poll] SUCCESS: Found transactionId ${transactionId} for ${chargerId} on attempt ${attempts + 1}`);
                await registerSession(transactionId, chargerId, checkoutId, userIdTag, customerId, paymentMethodId);
            } else {
                console.log(`[Poll] Attempt ${attempts + 1}/${maxAttempts}: No active tx in ${transactions.length} records for ${chargerId}`);
            }
        } catch (e) {
            console.error(`[Poll] Error on attempt ${attempts + 1}:`, e.message);
        }
        attempts++;
    }
    if (!transactionId) {
        console.error(`[Poll] FAILED: Could not find transactionId for ${chargerId} after 120s.`);
    }
    return transactionId;
}

/**
 * Orchestrates a complete RemoteStart sequence with polling
 */
export async function startChargingSequence(chargerId, userIdTag) {
    console.log(`[ChargerService] Starting sequence for ${chargerId} with user ${userIdTag}`);

    try {
        // 1. Pre-register as pending
        const pendingId = "pending_start_" + Date.now();
        await registerSession(pendingId, chargerId, null, userIdTag);

        // 2. Fire RemoteStart
        const res = await remoteStart(chargerId, userIdTag);

        const isAccepted = res[0]?.success || res.status === 'Accepted' || (Array.isArray(res) && res[0]?.status === 'Accepted');

        if (isAccepted) {
            console.log(`[ChargerService] Remote start accepted for ${chargerId}`);
        } else {
            console.error(`[ChargerService] Remote start failed for ${chargerId}:`, res);
            await pool.execute("DELETE FROM sessions WHERE transaction_id = ?", [pendingId]);
            throw new Error("START_FAILED");
        }

        // 3. Start Polling (Wait up to 36s for direct feedback)
        let transactionId = null;
        let attempts = 0;
        const maxInstantAttempts = 12;

        while (!transactionId && attempts < maxInstantAttempts) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            const transactions = await getTransactions();
            const latestTx = transactions
                .filter(tx => tx.stationId === chargerId && tx.isActive === true)
                .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];

            if (latestTx) {
                transactionId = latestTx.transactionId;
                console.log(`[ChargerService] Found Transaction ID: ${transactionId}`);
            }
            attempts++;
        }

        if (transactionId) {
            await registerSession(transactionId, chargerId, null, userIdTag);
            console.log(`[ChargerService] SUCCESS: Session confirmed with ID ${transactionId}`);
            return { success: true, transactionId };
        } else {
            console.warn(`[ChargerService] Transaction active but ID not yet found for ${chargerId}. Starting background poll.`);
            // TRIGGER BACKGROUND POLL so the frontend eventually finds it
            pollForTransactionId(chargerId, null, null, null, userIdTag);
            return { success: true, message: "Initiated. Polling continues." };
        }
    } catch (err) {
        console.error(`[ChargerService] Error in sequence for ${chargerId}:`, err.message);
        throw err;
    }
}

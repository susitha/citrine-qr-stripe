import express from "express";
import { getTransactions, remoteStop } from "../../citrineService.js";
import { getOrCreateIdTag, authenticateToken } from "../../authService.js";
import { startChargingSequence } from "../../chargerService.js";
import pool from "../../db.js";
import { stripe } from "../../stripeService.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Chargers
 *   description: Charger status and session control
 */

/**
 * @swagger
 * /api/v1/charger/status/{chargerId}:
 *   get:
 *     summary: Get charger status
 *     tags: [Chargers]
 *     parameters:
 *       - in: path
 *         name: chargerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Charger status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     chargerId:
 *                       type: string
 *                     status:
 *                       type: string
 *                     transactionId:
 *                       type: string
 *                     isWaitingForPlug:
 *                       type: boolean
 */
router.get("/status/:chargerId", async (req, res) => {
    const { chargerId } = req.params;
    try {
        const [localRows] = await pool.execute(
            `SELECT transaction_id, status, created_at FROM sessions 
       WHERE LOWER(charger_id) = LOWER(?) 
       AND (
         status = 'active' OR 
         (status = 'pending' AND created_at > UTC_TIMESTAMP() - INTERVAL 10 MINUTE)
       )
       ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`,
            [chargerId]
        );

        console.log(`[v1/Charger] status/:${chargerId} | DB rows: ${localRows.length}`);
        if (localRows.length > 0) {
            console.log(`[v1/Charger] Latest DB session: ID=${localRows[0].transaction_id}, Status=${localRows[0].status}`);
        }

        let activeTx = null;
        let fallbackToCitrine = true;

        if (localRows.length > 0 && localRows[0].status === 'active') {
            const txId = localRows[0].transaction_id;
            if (!String(txId).startsWith("pending")) {
                activeTx = { transactionId: txId, stationId: chargerId, isActive: true };
                fallbackToCitrine = false;
                console.log(`[v1/Charger] Found active DB session: ${txId}`);
            }
        }

        if (fallbackToCitrine) {
            console.log(`[v1/Charger] Falling back to Citrine for ${chargerId}...`);
            const transactions = await getTransactions();
            const cid = chargerId.toLowerCase().trim();
            const fiveMinsAgo = new Date(Date.now() - 5 * 60000);

            activeTx = transactions.find(tx => {
                const sid = String(tx.stationId || "").toLowerCase().trim();
                const hasEnded = !!tx.endTime;
                const startedRecently = tx.startTime && new Date(tx.startTime) > fiveMinsAgo;
                const isActive = (tx.isActive === true || tx.isActive === "true" || (!hasEnded && (tx.startTime || startedRecently)));
                return (sid === cid || sid.includes(cid) || cid.includes(sid)) && isActive;
            });
            if (activeTx) console.log(`[v1/Charger] Found active Citrine session: ${activeTx.transactionId}`);
        }

        const hasRecentPending = localRows.length > 0 &&
            localRows[0].status === 'pending' &&
            new Date(localRows[0].created_at) > new Date(Date.now() - 5 * 60000);

        const isWaitingForPlug = hasRecentPending && !activeTx;

        const responseData = {
            chargerId,
            status: activeTx ? "Occupied" : (hasRecentPending ? "Occupied" : "Available"),
            transactionId: activeTx?.transactionId || null,
            isWaitingForPlug: !!isWaitingForPlug
        };
        console.log(`[v1/Charger] Returning status: ${JSON.stringify(responseData)}`);
        res.json({ success: true, data: responseData });
    } catch (err) {
        console.error("[v1/Charger] status error:", err.message);
        res.status(500).json({ success: false, error: "Failed to fetch status", code: "STATUS_ERROR" });
    }
});

/**
 * @swagger
 * /api/v1/charger/session/{transactionId}:
 *   get:
 *     summary: Get session details
 *     tags: [Chargers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: transactionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session details retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
router.get("/session/:transactionId", authenticateToken, async (req, res) => {
    const { transactionId } = req.params;
    try {
        const transactions = await getTransactions();
        console.log(`[v1/Charger] Fetching session ${transactionId}. Found ${transactions.length} live transactions.`);

        const liveTx = transactions.find(t => String(t.transactionId) === String(transactionId));
        const isActive = liveTx && (liveTx.isActive === true || liveTx.isActive === "true");

        if (liveTx && isActive) {
            console.log(`[v1/Charger] Found active live transaction: ${JSON.stringify(liveTx)}`);
            return res.json({ success: true, data: liveTx });
        }

        console.log(`[v1/Charger] Session ${transactionId} not active in live list (isActive=${isActive}). Checking DB...`);
        const [rows] = await pool.execute("SELECT * FROM sessions WHERE transaction_id = ?", [transactionId]);
        const dbTx = rows[0];

        if (dbTx) {
            return res.json({
                success: true,
                data: {
                    transactionId: dbTx.transaction_id,
                    stationId: dbTx.charger_id,
                    isActive: dbTx.status !== 'completed',
                    status: dbTx.status,
                    final_charged: !!dbTx.final_charged,
                    startTime: dbTx.start_time,
                    endTime: dbTx.end_time,
                    totalKwh: dbTx.kwh || 0,
                    totalCost: dbTx.cost || 0
                }
            });
        }

        res.status(404).json({ success: false, error: "Session not found", code: "NOT_FOUND" });
    } catch (err) {
        res.status(500).json({ success: false, error: "Failed to fetch session", code: "FETCH_ERROR" });
    }
});

/**
 * @swagger
 * /api/v1/charger/start:
 *   post:
 *     summary: Start charging
 *     tags: [Chargers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chargerId]
 *             properties:
 *               chargerId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Start command sent
 */
router.post("/start", authenticateToken, async (req, res) => {
    const { chargerId } = req.body;
    const idTag = req.user.idTag || await getOrCreateIdTag(req.user.email);

    if (!chargerId) {
        return res.status(400).json({ success: false, error: "chargerId is required", code: "MISSING_FIELDS" });
    }

    try {
        const result = await startChargingSequence(chargerId, idTag);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, error: "Failed to start charging", code: "START_FAILED" });
    }
});

/**
 * @swagger
 * /api/v1/charger/stop:
 *   post:
 *     summary: Stop charging
 *     tags: [Chargers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chargerId, transactionId]
 *             properties:
 *               chargerId:
 *                 type: string
 *               transactionId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Stop command sent
 */
router.post("/stop", authenticateToken, async (req, res) => {
    const { chargerId, transactionId } = req.body;
    if (!chargerId || !transactionId) {
        return res.status(400).json({ success: false, error: "chargerId and transactionId are required", code: "MISSING_FIELDS" });
    }

    try {
        await remoteStop(chargerId, transactionId);
        res.json({ success: true, data: { message: "Stop command sent successfully" } });
    } catch (err) {
        res.status(500).json({ success: false, error: "Failed to stop charging", code: "STOP_FAILED" });
    }
});

export default router;

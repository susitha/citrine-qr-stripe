import express from "express";
import { createCheckoutSession, stripe } from "../../stripeService.js";
import { getOrCreateIdTag, authenticateToken } from "../../authService.js";
import { registerSession } from "../../billingService.js";
import pool from "../../db.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Billing
 *   description: Payments and Stripe checkout
 */

/**
 * @swagger
 * /api/v1/billing/checkout:
 *   post:
 *     summary: Create checkout session
 *     tags: [Billing]
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
 *               frontendOrigin:
 *                 type: string
 *     responses:
 *       200:
 *         description: Checkout URL generated
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
 *                     checkoutUrl:
 *                       type: string
 *                     sessionId:
 *                       type: string
 */
router.post("/checkout", authenticateToken, async (req, res) => {
    const { chargerId, platform } = req.body;
    const customerEmail = req.user.email;

    if (!chargerId) {
        return res.status(400).json({
            success: false,
            error: "chargerId is required",
            code: "MISSING_FIELDS"
        });
    }

    try {
        const idTag = req.user.idTag || await getOrCreateIdTag(customerEmail);

        let frontendBase = req.body.frontendOrigin;
        if (!frontendBase) {
            const origin = req.get("origin") || req.get("referer");
            frontendBase = origin
                ? new URL(origin).origin
                : (process.env.FRONTEND_URL || "http://localhost:3001");
        }

        const session = await createCheckoutSession(
            chargerId,
            frontendBase,
            customerEmail,
            idTag,
            platform
        );

        await registerSession("pending_pre_" + session.id, chargerId, session.id, idTag);

        res.json({
            success: true,
            data: {
                checkoutUrl: session.url,
                sessionId: session.id
            }
        });
    } catch (err) {
        console.error("[v1/Billing] checkout error:", err.message);
        res.status(500).json({
            success: false,
            error: "Failed to create checkout session",
            code: "STRIPE_ERROR"
        });
    }
});

/**
 * @swagger
 * /api/v1/billing/direct-status:
 *   get:
 *     summary: Check direct charging status
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Direct charging capability retrieved
 */
router.get("/direct-status", authenticateToken, async (req, res) => {
    const email = req.user.email;
    try {
        const customers = await stripe.customers.list({ email, limit: 1 });
        if (!customers.data.length) {
            return res.json({ success: true, data: { canDirect: false, reason: "NO_CUSTOMER" } });
        }
        const customer = customers.data[0];

        const [cardPms, linkPms] = await Promise.all([
            stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 1 }),
            stripe.paymentMethods.list({ customer: customer.id, type: "link", limit: 1 }),
        ]);

        const pm = cardPms.data[0] || linkPms.data[0];
        res.json({
            success: true,
            data: {
                canDirect: !!pm,
                customerId: customer.id,
                paymentMethodId: pm?.id || null
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: "Failed to check payment status", code: "STRIPE_ERROR" });
    }
});

/**
 * @swagger
 * /api/v1/billing/history:
 *   get:
 *     summary: Get charging history
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: History retrieved
 */
router.get("/history", authenticateToken, async (req, res) => {
    const idTag = req.user.idTag;
    if (!idTag) {
        return res.json({ success: true, data: [] });
    }

    try {
        const [rows] = await pool.execute(
            "SELECT transaction_id, charger_id, kwh, cost, start_time, end_time, status FROM sessions WHERE user_id_tag = ? ORDER BY created_at DESC LIMIT 50",
            [idTag]
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: "Failed to fetch history", code: "DB_ERROR" });
    }
});

export default router;

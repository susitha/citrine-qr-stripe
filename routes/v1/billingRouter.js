import express from "express";
import { createCheckoutSession, stripe } from "../../stripeService.js";
import { getOrCreateIdTag, authenticateToken } from "../../authService.js";
import { registerSession } from "../../billingService.js";
import pool from "../../db.js";

const router = express.Router();

/**
 * @route   POST /api/v1/billing/checkout
 * @desc    Create a Stripe Checkout session
 * @access  Private
 */
router.post("/checkout", authenticateToken, async (req, res) => {
    const { chargerId } = req.body;
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

        // Dynamic origin detection for redirects
        // If the frontend explicitly specifies the origin (needed for proxies), use it.
        let frontendBase = req.body.frontendOrigin;

        if (!frontendBase) {
            const origin = req.get('origin') || req.get('referer');
            frontendBase = origin ? new URL(origin).origin : (process.env.FRONTEND_URL || "http://localhost:3001");
        }

        console.log(`[v1/Billing] Creating checkout for ${chargerId}. Redirecting back to: ${frontendBase}`);

        const session = await createCheckoutSession(chargerId, frontendBase, customerEmail, idTag);

        // Pre-register so charger shows "Occupied"
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
 * @route   GET /api/v1/billing/direct-status
 * @desc    Check if user has a saved card for direct start
 * @access  Private
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
 * @route   GET /api/v1/billing/history
 * @desc    Get user's charging history
 * @access  Private
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

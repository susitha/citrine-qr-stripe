import express from "express";
import { requestOTP, verifyOTP } from "../../authService.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Authentication
 *   description: User authentication and OTP management
 */

/**
 * @swagger
 * /api/v1/auth/request-otp:
 *   post:
 *     summary: Request an OTP
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 example: user@example.com
 *               phone:
 *                 type: string
 *                 example: "+1234567890"
 *     responses:
 *       200:
 *         description: OTP sent successfully
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
 *                     message:
 *                       type: string
 *                     session:
 *                       type: string
 */
router.post("/request-otp", async (req, res) => {
    const method = process.env.OTP_METHOD || 'email';
    const { email, phone } = req.body;
    const identifier = method === 'sms' ? phone : email;

    if (!identifier) {
        return res.status(400).json({
            success: false,
            error: `${method === 'sms' ? 'Phone' : 'Email'} is required`,
            code: "MISSING_IDENTIFIER"
        });
    }

    try {
        const result = await requestOTP(identifier);
        res.json({
            success: true,
            data: {
                message: `OTP sent to your ${method}`,
                session: result.session
            }
        });
    } catch (err) {
        console.error("[v1/Auth] request-otp error:", err.message);
        res.status(500).json({
            success: false,
            error: "Failed to send OTP",
            code: "OTP_SEND_FAILED"
        });
    }
});

/**
 * @swagger
 * /api/v1/auth/verify-otp:
 *   post:
 *     summary: Verify OTP and get JWT
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [otp, session]
 *             properties:
 *               email:
 *                 type: string
 *               phone:
 *                 type: string
 *               otp:
 *                 type: string
 *               session:
 *                 type: string
 *     responses:
 *       200:
 *         description: Verified successfully
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
 *                     token:
 *                       type: string
 *                     user:
 *                       type: object
 */
router.post("/verify-otp", async (req, res) => {
    const method = process.env.OTP_METHOD || 'email';
    const { email, phone, otp, session } = req.body;
    const identifier = method === 'sms' ? phone : email;

    if (!identifier || !otp || !session) {
        return res.status(400).json({
            success: false,
            error: "Identifier, OTP, and session are required",
            code: "MISSING_FIELDS"
        });
    }

    try {
        const result = await verifyOTP(identifier, otp, session);
        if (result.success) {
            res.json({
                success: true,
                data: {
                    token: result.token,
                    user: result.user
                }
            });
        } else {
            res.status(401).json({
                success: false,
                error: result.message,
                code: "INVALID_OTP"
            });
        }
    } catch (err) {
        console.error("[v1/Auth] verify-otp error:", err.message);
        res.status(500).json({
            success: false,
            error: err.message || "Internal server error",
            code: "INTERNAL_ERROR"
        });
    }
});

export default router;

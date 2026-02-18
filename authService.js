import pool from './db.js';
import { sendOTPEmail } from './emailService.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'your-very-secret-key';
const OTP_EXPIRY_MINUTES = 10;

/**
 * Generate a random 6-digit OTP
 */
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Request an OTP for an email
 */
export async function requestOTP(email) {
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Store OTP in database
    await pool.execute(
        'INSERT INTO otps (email, otp, expires_at) VALUES (?, ?, ?)',
        [email, otp, expiresAt]
    );

    // Send email
    const sent = await sendOTPEmail(email, otp);
    return sent;
}

/**
 * Verify OTP and return a JWT if successful
 */
export async function verifyOTP(email, otp) {
    // Check for recent, valid OTP
    const [rows] = await pool.execute(
        'SELECT * FROM otps WHERE email = ? AND otp = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
        [email, otp]
    );

    if (rows.length === 0) {
        return { success: false, message: 'Invalid or expired OTP' };
    }

    // OTP is valid! Find or create user.
    let [userRows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    let user;

    if (userRows.length === 0) {
        const [result] = await pool.execute('INSERT INTO users (email) VALUES (?)', [email]);
        user = { id: result.insertId, email };
    } else {
        user = userRows[0];
    }

    // Delete all OTPs for this email to prevent reuse
    await pool.execute('DELETE FROM otps WHERE email = ?', [email]);

    // Create JWT
    const token = jwt.sign(
        { id: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: '7d' }
    );

    return { success: true, token, user };
}

/**
 * Middleware to verify JWT
 */
export function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Authentication required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}

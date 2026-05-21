import dns from 'dns';

// Force IPv4 globally for all Node.js network operations to bypass IPv6 DNS timeouts on macOS
const originalLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    if (typeof options === 'number') {
        options = { family: options };
    } else if (!options) {
        options = {};
    }
    if (options.family === undefined || options.family === 0) {
        options.family = 4;
    }
    return originalLookup.call(dns, hostname, options, callback);
};

import {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand,
    AdminGetUserCommand,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import crypto from 'crypto';
import dotenv from 'dotenv';
import pool from './db.js';
import { registerIdTag } from './citrineService.js';

dotenv.config();

const REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.AWS_COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.AWS_COGNITO_CLIENT_ID;
const CLIENT_SECRET = process.env.AWS_COGNITO_CLIENT_SECRET; // optional — only if app client has secret

/**
 * Compute SECRET_HASH required by Cognito when the app client has a secret.
 * Formula: Base64(HMAC-SHA256(username + clientId, clientSecret))
 */
function getSecretHash(username) {
    if (!CLIENT_SECRET) return undefined;
    return crypto
        .createHmac('sha256', CLIENT_SECRET)
        .update(username + CLIENT_ID)
        .digest('base64');
}

const cognitoClient = new CognitoIdentityProviderClient({
    region: REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// JWKS client — verifies Cognito-issued RS256 JWTs
const jwks = jwksClient({
    jwksUri: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`,
    cache: true,
    cacheMaxAge: 600000,
    rateLimit: true,
    jwksRequestsPerMinute: 10
});

/**
 * Workaround for Cognito pools requiring email usernames:
 * If identifier is a phone number, map it to a dummy email format.
 */
function getCognitoUsername(identifier) {
    if (identifier.includes('@')) return identifier;
    return `phone_${identifier.replace('+', '')}@voltcharge.internal`;
}

function getSigningKey(header, callback) {
    if (!header || !header.kid) {
        return callback(new Error("No kid in JWT header"));
    }
    jwks.getSigningKey(header.kid, (err, key) => {
        if (err) {
            console.error(`[Auth-JWKS] Failed to get signing key for kid ${header.kid}:`, err.message);
            return callback(err);
        }
        callback(null, key.getPublicKey());
    });
}

/**
 * Step 1 — Initiate OTP challenge (EMAIL_OTP or SMS_OTP)
 * @param {string} identifier - Email or Phone Number
 * @returns {{ session: string }} — Cognito session token for step 2
 */
export async function requestOTP(identifier) {
    const method = process.env.OTP_METHOD || 'email';
    const isSms = method === 'sms';
    const username = getCognitoUsername(identifier);

    // Auto-create/validate the user in Cognito.
    try {
        await cognitoClient.send(new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: username,
        }));
        console.log(`[Cognito] User ${username} already exists`);
    } catch (err) {
        if (err.name === 'UserNotFoundException') {
            const attributes = isSms
                ? [
                    { Name: 'email', Value: username },
                    { Name: 'email_verified', Value: 'true' },
                    { Name: 'phone_number', Value: identifier },
                    { Name: 'phone_number_verified', Value: 'true' }
                ]
                : [
                    { Name: 'email', Value: identifier },
                    { Name: 'email_verified', Value: 'true' },
                    { Name: 'phone_number', Value: '+10000000000' }
                ];

            await cognitoClient.send(new AdminCreateUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: username,
                UserAttributes: attributes,
                MessageAction: 'SUPPRESS',
            }));

            await cognitoClient.send(new AdminSetUserPasswordCommand({
                UserPoolId: USER_POOL_ID,
                Username: username,
                Password: crypto.randomBytes(16).toString('hex') + 'Aa1!',
                Permanent: true,
            }));
        } else {
            throw err;
        }
    }

    // --- NATIVE COGNITO FLOW ---
    console.log(`[Cognito] Initiating USER_AUTH for username: ${username}`);
    try {
        const initiateRes = await cognitoClient.send(new InitiateAuthCommand({
            AuthFlow: 'USER_AUTH',
            ClientId: CLIENT_ID,
            AuthParameters: {
                USERNAME: username,
                ...(getSecretHash(username) && { SECRET_HASH: getSecretHash(username) }),
            },
        }));

        console.log(`[Cognito] InitiateAuth success. Challenge: ${initiateRes.ChallengeName}`);
        let session = initiateRes.Session;
        let challengeName = initiateRes.ChallengeName;

        if (challengeName === 'SELECT_CHALLENGE') {
            const choice = isSms ? 'SMS_OTP' : 'EMAIL_OTP';
            const selectRes = await cognitoClient.send(new RespondToAuthChallengeCommand({
                ClientId: CLIENT_ID,
                ChallengeName: 'SELECT_CHALLENGE',
                Session: session,
                ChallengeResponses: {
                    USERNAME: username,
                    ANSWER: choice,
                    ...(getSecretHash(username) && { SECRET_HASH: getSecretHash(username) }),
                },
            }));
            session = selectRes.Session;
            challengeName = selectRes.ChallengeName;
        }

        const expectedChallenge = isSms ? 'SMS_OTP' : 'EMAIL_OTP';
        if (challengeName !== expectedChallenge) {
            throw new Error(`Unexpected Cognito challenge: ${challengeName}`);
        }

        console.log(`[Cognito] ${expectedChallenge} challenge initiated for ${username}`);
        return { success: true, session };
    } catch (err) {
        console.error(`[Cognito] requestOTP error for ${username}:`, err);
        throw err;
    }
}

/**
 * Step 2 — Verify the OTP code entered by the user.
 * @param {string} identifier - Email or Phone
 * @param {string} otp
 * @param {string} session
 */
export async function verifyOTP(identifier, otp, session) {
    const method = process.env.OTP_METHOD || 'email';
    const isSms = method === 'sms';
    const username = getCognitoUsername(identifier);
    const challengeName = isSms ? 'SMS_OTP' : 'EMAIL_OTP';
    const responseKey = isSms ? 'SMS_OTP_CODE' : 'EMAIL_OTP_CODE';

    try {
        const res = await cognitoClient.send(new RespondToAuthChallengeCommand({
            ClientId: CLIENT_ID,
            ChallengeName: challengeName,
            Session: session,
            ChallengeResponses: {
                USERNAME: username,
                [responseKey]: otp,
                ...(getSecretHash(username) && { SECRET_HASH: getSecretHash(username) }),
            },
        }));

        if (!res.AuthenticationResult) {
            return { success: false, message: 'Verification failed. Please try again.' };
        }

        const { AccessToken, IdToken } = res.AuthenticationResult;
        const decoded = jwt.decode(IdToken);
        const sub = decoded.sub;
        const email = decoded.email;

        // --- ID Tag Automation ---
        // 1. Check if user already has an id_tag in local DB
        let idTag = null;
        try {
            const [rows] = await pool.execute("SELECT id_tag FROM users WHERE email = ?", [email]);
            if (rows.length > 0 && rows[0].id_tag) {
                idTag = rows[0].id_tag;
            } else {
                // 2. If not, generate a new one
                idTag = "VOLT_" + crypto.randomBytes(4).toString('hex').toUpperCase();
                console.log(`[Auth] Generating new ID Tag for ${email}: ${idTag}`);

                // 3. Store in local DB (upsert user)
                await pool.execute(
                    "INSERT INTO users (email, id_tag) VALUES (?, ?) ON DUPLICATE KEY UPDATE id_tag = ?",
                    [email, idTag, idTag]
                );

                // 4. Register in CitrineOS
                const regResult = await registerIdTag(idTag);
                if (!regResult.success) {
                    console.error(`[Auth] Failed to register ID Tag ${idTag} in CitrineOS. User might need manual setup.`);
                }
            }
        } catch (dbErr) {
            console.error("[Auth] Database error during ID Tag check:", dbErr.message);
        }

        console.log(`[Cognito] ${challengeName} verified for ${username} (id_tag: ${idTag})`);
        return {
            success: true,
            token: IdToken,
            user: { id: sub, email: email, phone: decoded.phone_number, id_tag: idTag },
        };
    } catch (err) {
        console.error('[Cognito] verifyOTP error:', err.name, err.message);
        if (err.name === 'CodeMismatchException') return { success: false, message: 'Incorrect code.' };
        if (err.name === 'ExpiredCodeException') return { success: false, message: 'Code expired.' };
        if (err.name === 'NotAuthorizedException' && err.message.includes('expired')) {
            return { success: false, message: 'Verification session expired. Please request a new code.' };
        }
        throw err;
    }
}

/**
 * Ensure a user has an id_tag, generating/registering one if missing.
 */
export async function getOrCreateIdTag(email) {
    if (!email) {
        console.error("[Auth] getOrCreateIdTag: email is missing");
        return null;
    }
    try {
        const [rows] = await pool.execute("SELECT id_tag FROM users WHERE email = ?", [email]);
        if (rows.length > 0 && rows[0].id_tag) {
            return rows[0].id_tag;
        }

        // Generate and store
        const idTag = "VOLT_" + crypto.randomBytes(4).toString('hex').toUpperCase();
        console.log(`[Auth] getOrCreateIdTag: Generating new tag for ${email}: ${idTag}`);

        await pool.execute(
            "INSERT INTO users (email, id_tag) VALUES (?, ?) ON DUPLICATE KEY UPDATE id_tag = ?",
            [email, idTag, idTag]
        );

        // Register in CitrineOS
        const regResult = await registerIdTag(idTag);
        if (!regResult.success) {
            console.error(`[Auth] getOrCreateIdTag: CitrineOS registration failed for ${idTag}`);
        }

        return idTag;
    } catch (err) {
        console.error("[Auth] getOrCreateIdTag error:", err.message);
        return null;
    }
}

/**
 * Middleware: Verify Cognito JWT
 */
export async function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        console.warn(`[Auth-Debug] No token provided for ${req.path}`);
        return res.status(401).json({ error: 'Authentication required' });
    }

    jwt.verify(token, getSigningKey, {
        algorithms: ['RS256'],
        issuer: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
    }, async (err, decoded) => {
        if (err) {
            console.error(`[Auth-Debug] Token verification failed for ${req.path}:`, err.message);
            return res.status(403).json({ error: 'Invalid or expired token' });
        }

        const email = decoded.email || decoded['cognito:username'] || null;
        console.log(`[Auth-Debug] Token verified for: ${email} (sub: ${decoded.sub})`);

        if (!email) {
            console.warn(`[Auth-Debug] No email found in token for ${req.path}`);
        }

        let idTag = null;
        try {
            const [rows] = await pool.execute("SELECT id_tag FROM users WHERE email = ?", [email]);
            idTag = rows[0]?.id_tag || null;
        } catch (dbErr) {
            console.error("[Auth] DB error in authenticateToken:", dbErr.message);
        }

        req.user = { id: decoded.sub, email: email, idTag: idTag };
        next();
    });
}

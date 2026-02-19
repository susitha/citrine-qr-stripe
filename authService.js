import {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import crypto from 'crypto';
import dotenv from 'dotenv';

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
});

function getSigningKey(header, callback) {
    jwks.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
    });
}

/**
 * Step 1 — Initiate EMAIL_OTP challenge.
 * Cognito sends a 6-digit code to the user's email automatically.
 *
 * @param {string} email
 * @returns {{ session: string }} — Cognito session token for step 2
 */
export async function requestOTP(email) {
    // Initiate USER_AUTH — Cognito will offer available challenges
    const initiateRes = await cognitoClient.send(new InitiateAuthCommand({
        AuthFlow: 'USER_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
            USERNAME: email,
            ...(getSecretHash(email) && { SECRET_HASH: getSecretHash(email) }),
        },
    }));

    let session = initiateRes.Session;
    let challengeName = initiateRes.ChallengeName;

    // If Cognito offers a challenge selection, pick EMAIL_OTP
    if (challengeName === 'SELECT_CHALLENGE') {
        const selectRes = await cognitoClient.send(new RespondToAuthChallengeCommand({
            ClientId: CLIENT_ID,
            ChallengeName: 'SELECT_CHALLENGE',
            Session: session,
            ChallengeResponses: {
                USERNAME: email,
                ANSWER: 'EMAIL_OTP',
                ...(getSecretHash(email) && { SECRET_HASH: getSecretHash(email) }),
            },
        }));
        session = selectRes.Session;
        challengeName = selectRes.ChallengeName;
    }

    if (challengeName !== 'EMAIL_OTP') {
        throw new Error(`Unexpected Cognito challenge: ${challengeName}`);
    }

    console.log(`[Cognito] EMAIL_OTP challenge initiated for ${email}`);
    return { success: true, session };
}

/**
 * Step 2 — Verify the OTP code entered by the user.
 * Cognito validates the code and returns AccessToken + IdToken on success.
 *
 * @param {string} email
 * @param {string} otp   — 6-digit code from email
 * @param {string} session — session token from requestOTP()
 * @returns {{ success, token?, user?, message? }}
 */
export async function verifyOTP(email, otp, session) {
    try {
        const res = await cognitoClient.send(new RespondToAuthChallengeCommand({
            ClientId: CLIENT_ID,
            ChallengeName: 'EMAIL_OTP',
            Session: session,
            ChallengeResponses: {
                USERNAME: email,
                EMAIL_OTP: otp,
                ...(getSecretHash(email) && { SECRET_HASH: getSecretHash(email) }),
            },
        }));

        if (!res.AuthenticationResult) {
            return { success: false, message: 'Verification failed. Please try again.' };
        }

        const { AccessToken, IdToken } = res.AuthenticationResult;
        const decoded = jwt.decode(IdToken);

        console.log(`[Cognito] Email OTP verified for ${email}`);
        return {
            success: true,
            token: AccessToken,
            user: { id: decoded.sub, email: decoded.email || email },
        };
    } catch (err) {
        console.error('[Cognito] verifyOTP error:', err.name, err.message);

        if (err.name === 'CodeMismatchException') {
            return { success: false, message: 'Incorrect code. Please try again.' };
        }
        if (err.name === 'ExpiredCodeException') {
            return { success: false, message: 'Code has expired. Please request a new one.' };
        }
        if (err.name === 'NotAuthorizedException') {
            return { success: false, message: 'Session expired. Please request a new code.' };
        }
        throw err;
    }
}

/**
 * Express middleware — verify Cognito AccessToken from Authorization header.
 */
export function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    jwt.verify(token, getSigningKey, {
        algorithms: ['RS256'],
        issuer: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
    }, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = { id: decoded.sub, email: decoded.email };
        next();
    });
}

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

/**
 * Workaround for Cognito pools requiring email usernames:
 * If identifier is a phone number, map it to a dummy email format.
 */
function getCognitoUsername(identifier) {
    if (identifier.includes('@')) return identifier;
    return `phone_${identifier.replace('+', '')}@voltcharge.internal`;
}

function getSigningKey(header, callback) {
    jwks.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
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

        console.log(`[Cognito] ${challengeName} verified for ${username}`);
        return {
            success: true,
            token: AccessToken,
            user: { id: decoded.sub, email: decoded.email, phone: decoded.phone_number },
        };
    } catch (err) {
        console.error('[Cognito] verifyOTP error:', err.name, err.message);
        if (err.name === 'CodeMismatchException') return { success: false, message: 'Incorrect code.' };
        if (err.name === 'ExpiredCodeException') return { success: false, message: 'Code expired.' };
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

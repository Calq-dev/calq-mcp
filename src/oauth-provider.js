import crypto from 'crypto';
import https from 'https';
import { eq, lt } from 'drizzle-orm';
import {
    createUser,
    getUser,
    getUsers,
    updateUser
} from './storage.js';
import {
    db,
    oauthClients,
    oauthAccessTokens,
    oauthRefreshTokens,
    oauthAuthCodes
} from './db/index.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.MCP_PORT || 3000}`;

// In-memory store for pending GitHub auth (short-lived, during redirect only)
const pendingAuths = new Map();

/**
 * GitHub OAuth helper - exchange code for token
 */
async function exchangeGitHubCode(code) {
    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: code
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'github.com',
            path: '/login/oauth/access_token',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse GitHub response'));
                }
            });
        });
        req.on('error', reject);
        req.write(params.toString());
        req.end();
    });
}

/**
 * GitHub OAuth helper - get user info
 */
async function getGitHubUser(accessToken) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.github.com',
            path: '/user',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'Calq-MCP',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse GitHub user response'));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Create or get user from GitHub profile
 */
async function getOrCreateUser(githubUser) {
    let user = await getUser(githubUser.id.toString());

    if (!user) {
        const users = await getUsers();
        const role = users.length === 0 ? 'admin' : 'member';

        user = await createUser(
            githubUser.login,
            githubUser.email || `${githubUser.login}@github`,
            role,
            githubUser.id.toString()
        );
    }

    await updateUser(user.id, { lastLogin: new Date().toISOString() });
    return user;
}

/**
 * PKCE code verifier validation
 */
function verifyCodeChallenge(codeVerifier, codeChallenge) {
    const hash = crypto.createHash('sha256').update(codeVerifier).digest();
    const computed = hash.toString('base64url');
    return computed === codeChallenge;
}

/**
 * Generate random token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Clean up expired tokens (called periodically)
 */
async function cleanupExpiredTokens() {
    const now = new Date();
    try {
        await db.delete(oauthAccessTokens).where(lt(oauthAccessTokens.expiresAt, now));
        await db.delete(oauthAuthCodes).where(lt(oauthAuthCodes.expiresAt, now));
    } catch (error) {
        console.error('Token cleanup error:', error.message);
    }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredTokens, 10 * 60 * 1000);

/**
 * OAuth Server Provider implementation for MCP SDK
 * Uses PostgreSQL for persistence (survives restarts)
 */
export class GitHubOAuthProvider {
    constructor() {
        this.skipLocalPkceValidation = false;
    }

    get clientsStore() {
        return {
            getClient: async (clientId) => {
                const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
                if (!client) return null;
                return {
                    client_id: client.clientId,
                    client_secret: client.clientSecret,
                    client_name: client.clientName,
                    redirect_uris: client.redirectUris ? JSON.parse(client.redirectUris) : [],
                    client_id_issued_at: client.clientIdIssuedAt
                };
            },
            registerClient: async (clientInfo) => {
                const clientId = generateToken();
                const clientSecret = generateToken();
                const clientIdIssuedAt = Math.floor(Date.now() / 1000);

                await db.insert(oauthClients).values({
                    clientId,
                    clientSecret,
                    clientName: clientInfo.client_name || 'MCP Client',
                    redirectUris: JSON.stringify(clientInfo.redirect_uris || []),
                    clientIdIssuedAt
                });

                return {
                    ...clientInfo,
                    client_id: clientId,
                    client_secret: clientSecret,
                    client_id_issued_at: clientIdIssuedAt
                };
            }
        };
    }

    /**
     * Start authorization - redirect to GitHub
     */
    async authorize(client, params, res) {
        // Store the OAuth params and redirect to GitHub
        const state = generateToken();

        // Store pending authorization (in-memory, short-lived during redirect)
        const pendingAuth = {
            clientId: client.client_id,
            codeChallenge: params.codeChallenge,
            redirectUri: params.redirectUri,
            scopes: params.scopes,
            originalState: params.state,
            resource: params.resource
        };

        pendingAuths.set(state, pendingAuth);

        // Auto-cleanup pending auth after 10 minutes
        setTimeout(() => pendingAuths.delete(state), 10 * 60 * 1000);

        // Redirect to GitHub OAuth
        const githubParams = new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            redirect_uri: `${BASE_URL}/oauth/github/callback`,
            scope: 'user:email',
            state: state
        });

        res.redirect(`https://github.com/login/oauth/authorize?${githubParams}`);
    }

    /**
     * Handle GitHub callback - called from Express route
     */
    async handleGitHubCallback(code, state) {
        const pending = pendingAuths.get(state);

        if (!pending) {
            throw new Error('Invalid or expired state');
        }

        pendingAuths.delete(state);

        // Exchange GitHub code for token
        const githubTokenResponse = await exchangeGitHubCode(code);
        if (githubTokenResponse.error) {
            throw new Error(githubTokenResponse.error_description || githubTokenResponse.error);
        }

        // Get GitHub user info
        const githubUser = await getGitHubUser(githubTokenResponse.access_token);

        // Create/get local user
        const user = await getOrCreateUser(githubUser);

        // Generate authorization code for the MCP client
        const authCode = generateToken();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Store auth code in database
        await db.insert(oauthAuthCodes).values({
            code: authCode,
            clientId: pending.clientId,
            userId: user.id,
            codeChallenge: pending.codeChallenge,
            redirectUri: pending.redirectUri,
            scopes: JSON.stringify(pending.scopes || []),
            resource: pending.resource,
            expiresAt
        });

        // Build redirect URL back to MCP client
        const redirectUrl = new URL(pending.redirectUri);
        redirectUrl.searchParams.set('code', authCode);
        if (pending.originalState) {
            redirectUrl.searchParams.set('state', pending.originalState);
        }

        return redirectUrl.toString();
    }

    /**
     * Get code challenge for authorization code
     */
    async challengeForAuthorizationCode(client, authorizationCode) {
        const [authData] = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.code, authorizationCode)).limit(1);
        if (!authData || authData.clientId !== client.client_id) {
            throw new Error('Invalid authorization code');
        }
        return authData.codeChallenge;
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri, resource) {
        const [authData] = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.code, authorizationCode)).limit(1);

        if (!authData) {
            throw new Error('Invalid authorization code');
        }

        if (authData.clientId !== client.client_id) {
            throw new Error('Client ID mismatch');
        }

        if (new Date(authData.expiresAt) < new Date()) {
            await db.delete(oauthAuthCodes).where(eq(oauthAuthCodes.code, authorizationCode));
            throw new Error('Authorization code expired');
        }

        if (redirectUri && authData.redirectUri !== redirectUri) {
            throw new Error('Redirect URI mismatch');
        }

        // Verify PKCE
        if (codeVerifier && authData.codeChallenge) {
            if (!verifyCodeChallenge(codeVerifier, authData.codeChallenge)) {
                throw new Error('Invalid code verifier');
            }
        }

        // Clean up authorization code (single use)
        await db.delete(oauthAuthCodes).where(eq(oauthAuthCodes.code, authorizationCode));

        // Generate tokens
        const accessToken = generateToken();
        const refreshToken = generateToken();
        const expiresIn = 3600; // 1 hour
        const expiresAt = new Date(Date.now() + expiresIn * 1000);

        const scopes = authData.scopes ? JSON.parse(authData.scopes) : [];

        // Store access token in database
        await db.insert(oauthAccessTokens).values({
            token: accessToken,
            clientId: client.client_id,
            userId: authData.userId,
            scopes: JSON.stringify(scopes),
            expiresAt
        });

        // Store refresh token in database
        await db.insert(oauthRefreshTokens).values({
            token: refreshToken,
            clientId: client.client_id,
            userId: authData.userId,
            scopes: JSON.stringify(scopes)
        });

        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: expiresIn,
            refresh_token: refreshToken
        };
    }

    /**
     * Exchange refresh token for new access token
     */
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
        const [tokenData] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.token, refreshToken)).limit(1);

        if (!tokenData || tokenData.clientId !== client.client_id) {
            throw new Error('Invalid refresh token');
        }

        // Generate new access token
        const accessToken = generateToken();
        const expiresIn = 3600;
        const expiresAt = new Date(Date.now() + expiresIn * 1000);

        const tokenScopes = scopes || (tokenData.scopes ? JSON.parse(tokenData.scopes) : []);

        await db.insert(oauthAccessTokens).values({
            token: accessToken,
            clientId: client.client_id,
            userId: tokenData.userId,
            scopes: JSON.stringify(tokenScopes),
            expiresAt
        });

        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: expiresIn,
            refresh_token: refreshToken
        };
    }

    /**
     * Verify access token
     */
    async verifyAccessToken(token) {
        const [tokenData] = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.token, token)).limit(1);

        if (!tokenData) {
            throw new Error('Invalid access token');
        }

        if (new Date(tokenData.expiresAt) < new Date()) {
            await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.token, token));
            throw new Error('Access token expired');
        }

        // Get user info
        const user = await getUser(tokenData.userId);
        console.log('Token verified for user:', user?.username || tokenData.userId);

        return {
            clientId: tokenData.clientId,
            scopes: tokenData.scopes ? JSON.parse(tokenData.scopes) : [],
            expiresAt: Math.floor(new Date(tokenData.expiresAt).getTime() / 1000),
            userId: tokenData.userId,
            user: user
        };
    }

    /**
     * Revoke token
     */
    async revokeToken(client, request) {
        const token = request.token;

        // Try to delete from both tables
        await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.token, token));
        await db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.token, token));
    }
}

// Export singleton instance
export const oauthProvider = new GitHubOAuthProvider();

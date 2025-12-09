import crypto from 'crypto';
import https from 'https';
import {
    createUser,
    getUser,
    getUsers,
    updateUser
} from './storage.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.MCP_PORT || 3000}`;

// In-memory stores (use Redis/DB in production for multiple instances)
const authorizationCodes = new Map(); // code -> { clientId, codeChallenge, redirectUri, githubCode, userId, expiresAt }
const accessTokens = new Map(); // token -> { clientId, userId, scopes, expiresAt }
const refreshTokens = new Map(); // token -> { clientId, userId, scopes }
const registeredClients = new Map(); // clientId -> client info

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
 * OAuth Server Provider implementation for MCP SDK
 */
export class GitHubOAuthProvider {
    constructor() {
        this.skipLocalPkceValidation = false;
    }

    get clientsStore() {
        return {
            getClient: (clientId) => {
                return registeredClients.get(clientId);
            },
            registerClient: (clientInfo) => {
                const clientId = generateToken();
                const clientSecret = generateToken();
                const client = {
                    ...clientInfo,
                    client_id: clientId,
                    client_secret: clientSecret,
                    client_id_issued_at: Math.floor(Date.now() / 1000)
                };
                registeredClients.set(clientId, client);
                return client;
            }
        };
    }

    /**
     * Start authorization - redirect to GitHub
     */
    async authorize(client, params, res) {
        // Store the OAuth params and redirect to GitHub
        const state = generateToken();

        // Store pending authorization
        const pendingAuth = {
            clientId: client.client_id,
            codeChallenge: params.codeChallenge,
            redirectUri: params.redirectUri,
            scopes: params.scopes,
            originalState: params.state,
            resource: params.resource
        };

        // Use state to link GitHub callback to this auth request
        authorizationCodes.set(`pending_${state}`, pendingAuth);

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
        const pendingKey = `pending_${state}`;
        const pending = authorizationCodes.get(pendingKey);

        if (!pending) {
            throw new Error('Invalid or expired state');
        }

        authorizationCodes.delete(pendingKey);

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
        authorizationCodes.set(authCode, {
            clientId: pending.clientId,
            codeChallenge: pending.codeChallenge,
            redirectUri: pending.redirectUri,
            userId: user.id,
            scopes: pending.scopes,
            resource: pending.resource,
            expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
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
        const authData = authorizationCodes.get(authorizationCode);
        if (!authData || authData.clientId !== client.client_id) {
            throw new Error('Invalid authorization code');
        }
        return authData.codeChallenge;
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri, resource) {
        const authData = authorizationCodes.get(authorizationCode);

        if (!authData) {
            throw new Error('Invalid authorization code');
        }

        if (authData.clientId !== client.client_id) {
            throw new Error('Client ID mismatch');
        }

        if (authData.expiresAt < Date.now()) {
            authorizationCodes.delete(authorizationCode);
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
        authorizationCodes.delete(authorizationCode);

        // Generate tokens
        const accessToken = generateToken();
        const refreshToken = generateToken();
        const expiresIn = 3600; // 1 hour

        accessTokens.set(accessToken, {
            clientId: client.client_id,
            userId: authData.userId,
            scopes: authData.scopes || [],
            expiresAt: Date.now() + expiresIn * 1000
        });

        refreshTokens.set(refreshToken, {
            clientId: client.client_id,
            userId: authData.userId,
            scopes: authData.scopes || []
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
        const tokenData = refreshTokens.get(refreshToken);

        if (!tokenData || tokenData.clientId !== client.client_id) {
            throw new Error('Invalid refresh token');
        }

        // Generate new access token
        const accessToken = generateToken();
        const expiresIn = 3600;

        accessTokens.set(accessToken, {
            clientId: client.client_id,
            userId: tokenData.userId,
            scopes: scopes || tokenData.scopes || [],
            expiresAt: Date.now() + expiresIn * 1000
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
        const tokenData = accessTokens.get(token);

        if (!tokenData) {
            throw new Error('Invalid access token');
        }

        if (tokenData.expiresAt < Date.now()) {
            accessTokens.delete(token);
            throw new Error('Access token expired');
        }

        // Get user info
        const user = await getUser(tokenData.userId);

        return {
            clientId: tokenData.clientId,
            scopes: tokenData.scopes,
            expiresAt: Math.floor(tokenData.expiresAt / 1000),
            userId: tokenData.userId,
            user: user
        };
    }

    /**
     * Revoke token
     */
    async revokeToken(client, request) {
        const token = request.token;

        if (accessTokens.has(token)) {
            accessTokens.delete(token);
        }

        if (refreshTokens.has(token)) {
            refreshTokens.delete(token);
        }
    }
}

// Export singleton instance
export const oauthProvider = new GitHubOAuthProvider();

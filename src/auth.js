import {
    createUser,
    getUser,
    getUsers,
    updateUser,
    deleteUser
} from './storage.js';
import https from 'https';
import crypto from 'crypto';

// Re-export user functions for usage in index.js
export { createUser, getUser, getUsers, updateUser, deleteUser };

// ==================== GITHUB OAUTH ====================

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.MCP_PORT || 3000}`;
const OAUTH_CALLBACK_URL = process.env.OAUTH_CALLBACK_URL || `${BASE_URL}/oauth/callback`;

// Store pending OAuth states (state -> { mcpSessionId, createdAt })
const pendingStates = new Map();

/**
 * Generate OAuth authorization URL
 * @param {string} mcpSessionId - Optional MCP session ID to link auth to
 * @returns {Object} Auth URL and state
 */
export function getAuthUrl(mcpSessionId = null) {
    if (!GITHUB_CLIENT_ID) {
        throw new Error('GITHUB_CLIENT_ID environment variable is required');
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, { mcpSessionId, createdAt: Date.now() });

    // Clean up old states (older than 10 minutes)
    for (const [s, data] of pendingStates) {
        if (Date.now() - data.createdAt > 600000) {
            pendingStates.delete(s);
        }
    }

    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: OAUTH_CALLBACK_URL,
        scope: 'user:email',
        state: state
    });

    return {
        url: `https://github.com/login/oauth/authorize?${params}`,
        state: state
    };
}

/**
 * Get MCP session ID from pending state
 * @param {string} state - OAuth state
 * @returns {string|null} MCP session ID or null
 */
export function getMcpSessionFromState(state) {
    const data = pendingStates.get(state);
    return data?.mcpSessionId || null;
}

/**
 * Exchange code for access token
 * @param {string} code - Authorization code
 * @param {string} state - State to verify
 * @returns {Promise<Object>} Access token response
 */
async function exchangeCodeForToken(code, state) {
    if (!pendingStates.has(state)) {
        throw new Error('Invalid or expired state');
    }
    pendingStates.delete(state);

    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: code,
        redirect_uri: OAUTH_CALLBACK_URL
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
                    reject(new Error('Failed to parse response'));
                }
            });
        });

        req.on('error', reject);
        req.write(params.toString());
        req.end();
    });
}

/**
 * Get GitHub user info
 * @param {string} accessToken - Access token
 * @returns {Promise<Object>} User info
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
                    reject(new Error('Failed to parse response'));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

/**
 * Handle OAuth callback and create/update user
 * @param {string} code - Authorization code
 * @param {string} state - State to verify
 * @returns {Promise<Object>} User info
 */
export async function handleOAuthCallback(code, state) {
    const tokenResponse = await exchangeCodeForToken(code, state);

    if (tokenResponse.error) {
        throw new Error(tokenResponse.error_description || tokenResponse.error);
    }

    const githubUser = await getGitHubUser(tokenResponse.access_token);

    // Check if user exists
    let user = await getUser(githubUser.id.toString());

    if (!user) {
        // Check if this is the first user (make them admin)
        const users = await getUsers();
        const role = users.length === 0 ? 'admin' : 'member';

        // Create new user
        user = await createUser(
            githubUser.login,
            githubUser.email || `${githubUser.login}@github`,
            role,
            githubUser.id.toString()
        );
    }

    // Update last login
    await updateUser(user.id, { lastLogin: new Date().toISOString() });

    return {
        user: user,
        githubUser: githubUser
    };
}


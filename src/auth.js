import { loadData, saveData } from './storage.js';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import crypto from 'crypto';

// ==================== USER MANAGEMENT ====================

/**
 * Create a new user
 * @param {string} username - Username (usually GitHub username)
 * @param {string} email - Email
 * @param {string} role - Role: 'admin' or 'member'
 * @param {string} githubId - Optional GitHub user ID
 * @returns {Object} The created user
 */
export function createUser(username, email, role = 'member', githubId = null) {
    const data = loadData();

    if (!data.users) data.users = {};

    const id = username.toLowerCase().trim();

    if (data.users[id]) {
        return { error: 'User already exists', user: data.users[id] };
    }

    const user = {
        id: id,
        username: username,
        email: email,
        role: role, // 'admin' or 'member'
        githubId: githubId,
        createdAt: new Date().toISOString(),
        lastLogin: null
    };

    data.users[id] = user;
    saveData(data);

    return user;
}

/**
 * Get all users
 * @returns {Array} List of users
 */
export function getUsers() {
    const data = loadData();
    return Object.values(data.users || {}).map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        lastLogin: u.lastLogin
    }));
}

/**
 * Get a user by ID or GitHub ID
 * @param {string} identifier - User ID or GitHub ID
 * @returns {Object|null} The user or null
 */
export function getUser(identifier) {
    const data = loadData();

    // Try by ID first
    if (data.users?.[identifier.toLowerCase()]) {
        return data.users[identifier.toLowerCase()];
    }

    // Try by GitHub ID
    for (const user of Object.values(data.users || {})) {
        if (user.githubId === identifier) {
            return user;
        }
    }

    return null;
}

/**
 * Update a user
 * @param {string} userId - User ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} Updated user or null
 */
export function updateUser(userId, updates) {
    const data = loadData();
    const id = userId.toLowerCase();

    if (!data.users?.[id]) return null;

    if (updates.email !== undefined) data.users[id].email = updates.email;
    if (updates.role !== undefined) data.users[id].role = updates.role;
    if (updates.lastLogin !== undefined) data.users[id].lastLogin = updates.lastLogin;

    saveData(data);
    return data.users[id];
}

/**
 * Delete a user
 * @param {string} userId - User ID
 * @returns {Object|null} Deleted user or null
 */
export function deleteUser(userId) {
    const data = loadData();
    const id = userId.toLowerCase();

    if (!data.users?.[id]) return null;

    const deleted = data.users[id];
    delete data.users[id];
    saveData(data);

    return deleted;
}

/**
 * Check if user has admin role
 * @param {string} userId - User ID
 * @returns {boolean} True if admin
 */
export function isAdmin(userId) {
    const user = getUser(userId);
    return user?.role === 'admin';
}

/**
 * Validate that the current user (from CALQ_USER env) is registered
 * @returns {Object} Result with valid boolean and user/error
 */
export function validateCurrentUser() {
    const userId = process.env.CALQ_USER;

    if (!userId) {
        return {
            valid: false,
            error: 'CALQ_USER environment variable not set. Please login at http://localhost:3847'
        };
    }

    const user = getUser(userId);

    if (!user) {
        return {
            valid: false,
            error: `User "${userId}" not found. Please login at http://localhost:3847`
        };
    }

    return {
        valid: true,
        user: user
    };
}

/**
 * Get current user or throw error
 * @returns {Object} Current user
 */
export function requireUser() {
    const result = validateCurrentUser();
    if (!result.valid) {
        throw new Error(result.error);
    }
    return result.user;
}

/**
 * Check if current user is admin
 * @returns {boolean} True if admin
 */
export function requireAdmin() {
    const user = requireUser();
    if (user.role !== 'admin') {
        throw new Error('Admin access required');
    }
    return user;
}

// ==================== GITHUB OAUTH ====================

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const OAUTH_CALLBACK_URL = process.env.OAUTH_CALLBACK_URL || 'http://localhost:3847/callback';

// Store pending OAuth states
const pendingStates = new Map();

/**
 * Generate OAuth authorization URL
 * @returns {Object} Auth URL and state
 */
export function getAuthUrl() {
    if (!GITHUB_CLIENT_ID) {
        throw new Error('GITHUB_CLIENT_ID environment variable is required');
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, { createdAt: Date.now() });

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
    let user = getUser(githubUser.id.toString());

    if (!user) {
        // Check if this is the first user (make them admin)
        const users = getUsers();
        const role = users.length === 0 ? 'admin' : 'member';

        // Create new user
        user = createUser(
            githubUser.login,
            githubUser.email || `${githubUser.login}@github`,
            role,
            githubUser.id.toString()
        );
    }

    // Update last login
    updateUser(user.id, { lastLogin: new Date().toISOString() });

    return {
        user: user,
        githubUser: githubUser
    };
}

/**
 * Start OAuth HTTP server
 * @param {number} port - Port to listen on
 * @returns {http.Server} The HTTP server
 */
export function startAuthServer(port = 3847) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);

        if (url.pathname === '/login') {
            try {
                const { url: authUrl } = getAuthUrl();
                res.writeHead(302, { Location: authUrl });
                res.end();
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Error: ${error.message}`);
            }
        }
        else if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');

            if (!code || !state) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing code or state');
                return;
            }

            try {
                const result = await handleOAuthCallback(code, state);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <!DOCTYPE html>
                    <html>
                    <head><title>Calq - Logged In</title></head>
                    <body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h1>✅ Logged in as ${result.user.username}</h1>
                        <p>Role: ${result.user.role}</p>
                        <p>You can close this window.</p>
                        <p style="margin-top: 40px; color: #666;">
                            Set <code>CALQ_USER=${result.user.id}</code> in your MCP config.
                        </p>
                    </body>
                    </html>
                `);
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Error: ${error.message}`);
            }
        }
        else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <!DOCTYPE html>
                <html>
                <head><title>Calq Auth</title></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                    <h1>🔐 Calq Authentication</h1>
                    <a href="/login" style="display: inline-block; padding: 12px 24px; background: #333; color: white; text-decoration: none; border-radius: 6px;">
                        Login with GitHub
                    </a>
                </body>
                </html>
            `);
        }
    });

    server.listen(port, () => {
        console.error(`Auth server running on http://localhost:${port}`);
    });

    return server;
}

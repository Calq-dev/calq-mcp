import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Data directory
const DATA_DIR = process.env.CALQ_DATA_DIR || path.join(os.homedir(), '.calq');
const DB_PATH = path.join(DATA_DIR, 'calq.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize database
let db = null;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        initSchema();
    }
    return db;
}

function initSchema() {
    const database = db;

    // Users table
    database.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            email TEXT,
            role TEXT DEFAULT 'member',
            github_id TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_login TEXT
        )
    `);

    // Clients table
    database.exec(`
        CREATE TABLE IF NOT EXISTS clients (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Projects table
    database.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            client_id TEXT,
            hourly_rate REAL DEFAULT 0,
            notes TEXT,
            total_minutes INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (client_id) REFERENCES clients(id)
        )
    `);

    // Entries table
    database.exec(`
        CREATE TABLE IF NOT EXISTS entries (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            minutes INTEGER NOT NULL,
            description TEXT,
            type TEXT DEFAULT 'commit',
            billable INTEGER DEFAULT 1,
            billed INTEGER DEFAULT 0,
            user_id TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // Memories table (metadata only - vectors in ChromaDB)
    database.exec(`
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            category TEXT,
            shared INTEGER DEFAULT 1,
            project_id TEXT,
            client_id TEXT,
            user_id TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id),
            FOREIGN KEY (client_id) REFERENCES clients(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // Active timer table (one per user)
    database.exec(`
        CREATE TABLE IF NOT EXISTS active_timer (
            user_id TEXT PRIMARY KEY,
            project_id TEXT,
            description TEXT,
            started_at TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // Create indexes
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);
        CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
        CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
    `);
}

// ==================== HELPER FUNCTIONS ====================

export function formatDuration(minutes) {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getCurrentUser() {
    return process.env.CALQ_USER || 'unknown';
}

// ==================== PROJECT FUNCTIONS ====================

export function getOrCreateProject(projectName) {
    const database = getDb();
    const id = projectName.toLowerCase().trim().replace(/\s+/g, '-');

    let project = database.prepare('SELECT * FROM projects WHERE id = ?').get(id);

    if (!project) {
        database.prepare(`
            INSERT INTO projects (id, name, total_minutes) VALUES (?, ?, 0)
        `).run(id, projectName);
        project = { id, name: projectName, total_minutes: 0 };
    }

    return project;
}

export function getProjects() {
    const database = getDb();
    return database.prepare(`
        SELECT p.*, c.name as client_name 
        FROM projects p 
        LEFT JOIN clients c ON p.client_id = c.id
        ORDER BY p.total_minutes DESC
    `).all();
}

export function getProjectsWithClients(clientFilter = null) {
    const database = getDb();
    let query = `
        SELECT p.*, c.name as client_name,
               (p.total_minutes / 60.0) * p.hourly_rate as estimated_value
        FROM projects p 
        LEFT JOIN clients c ON p.client_id = c.id
    `;

    if (clientFilter) {
        query += ` WHERE c.name LIKE ?`;
        const projects = database.prepare(query).all(`%${clientFilter}%`);
        return projects.map(p => ({
            ...p,
            totalFormatted: formatDuration(p.total_minutes),
            estimatedValue: p.estimated_value ? p.estimated_value.toFixed(2) : null
        }));
    }

    const projects = database.prepare(query).all();
    return projects.map(p => ({
        ...p,
        totalFormatted: formatDuration(p.total_minutes),
        estimatedValue: p.estimated_value ? p.estimated_value.toFixed(2) : null
    }));
}

export function createProject(name, clientName = null, hourlyRate = 0, notes = '') {
    const database = getDb();
    const id = name.toLowerCase().trim().replace(/\s+/g, '-');

    let clientId = null;
    if (clientName) {
        const client = database.prepare('SELECT id FROM clients WHERE name LIKE ?').get(`%${clientName}%`);
        if (client) clientId = client.id;
    }

    const existing = database.prepare('SELECT * FROM projects WHERE id = ?').get(id);

    if (existing) {
        database.prepare(`
            UPDATE projects SET client_id = ?, hourly_rate = ?, notes = ? WHERE id = ?
        `).run(clientId, hourlyRate, notes, id);
    } else {
        database.prepare(`
            INSERT INTO projects (id, name, client_id, hourly_rate, notes) VALUES (?, ?, ?, ?, ?)
        `).run(id, name, clientId, hourlyRate, notes);
    }

    return database.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProject(projectId, updates) {
    const database = getDb();
    const sets = [];
    const values = [];

    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.clientId !== undefined) { sets.push('client_id = ?'); values.push(updates.clientId); }
    if (updates.hourlyRate !== undefined) { sets.push('hourly_rate = ?'); values.push(updates.hourlyRate); }
    if (updates.notes !== undefined) { sets.push('notes = ?'); values.push(updates.notes); }

    if (sets.length > 0) {
        values.push(projectId);
        database.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    return database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
}

// ==================== ENTRY FUNCTIONS ====================

export function addEntry(projectName, minutes, description, type = 'commit', billable = true, date = null, userId = null) {
    const database = getDb();
    const project = getOrCreateProject(projectName);
    const id = generateId();
    const user = userId || getCurrentUser();

    let createdAt;
    if (date) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            createdAt = date + 'T12:00:00.000Z';
        } else {
            createdAt = new Date(date).toISOString();
        }
    } else {
        createdAt = new Date().toISOString();
    }

    database.prepare(`
        INSERT INTO entries (id, project_id, minutes, description, type, billable, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, project.id, minutes, description, type, billable ? 1 : 0, user, createdAt);

    // Update project total
    database.prepare('UPDATE projects SET total_minutes = total_minutes + ? WHERE id = ?')
        .run(minutes, project.id);

    const entry = { id, project: project.id, minutes, description, type, billable, userId: user, createdAt };

    // Index in ChromaDB for semantic search (async, non-blocking)
    import('./memory.js').then(({ indexEntry }) => {
        indexEntry(entry).catch(() => {});
    }).catch(() => {});

    return entry;
}

export function getProjectEntries(projectId) {
    const database = getDb();
    return database.prepare(`
        SELECT e.*, u.username 
        FROM entries e 
        LEFT JOIN users u ON e.user_id = u.id
        WHERE e.project_id = ? 
        ORDER BY e.created_at DESC
    `).all(projectId);
}

export function deleteEntry(entryId) {
    const database = getDb();
    const entry = database.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);

    if (!entry) return null;

    // Update project total
    database.prepare('UPDATE projects SET total_minutes = total_minutes - ? WHERE id = ?')
        .run(entry.minutes, entry.project_id);

    database.prepare('DELETE FROM entries WHERE id = ?').run(entryId);

    // Remove from ChromaDB (async, non-blocking)
    import('./memory.js').then(({ deleteEntryFromChroma }) => {
        deleteEntryFromChroma(entryId).catch(() => {});
    }).catch(() => {});

    return entry;
}

export function editEntry(entryId, updates) {
    const database = getDb();
    const entry = database.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);

    if (!entry) return null;

    const sets = [];
    const values = [];
    let minutesDiff = 0;

    if (updates.minutes !== undefined) {
        minutesDiff = updates.minutes - entry.minutes;
        sets.push('minutes = ?');
        values.push(updates.minutes);
    }
    if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
    if (updates.billable !== undefined) { sets.push('billable = ?'); values.push(updates.billable ? 1 : 0); }
    if (updates.billed !== undefined) { sets.push('billed = ?'); values.push(updates.billed ? 1 : 0); }

    if (sets.length > 0) {
        values.push(entryId);
        database.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);

        if (minutesDiff !== 0) {
            database.prepare('UPDATE projects SET total_minutes = total_minutes + ? WHERE id = ?')
                .run(minutesDiff, entry.project_id);
        }
    }

    return database.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
}

export function getLastEntry() {
    const database = getDb();
    return database.prepare('SELECT * FROM entries ORDER BY created_at DESC LIMIT 1').get();
}

// ==================== SUMMARY FUNCTIONS ====================

export function getTodaySummary(userId = null) {
    const database = getDb();
    const today = new Date().toISOString().split('T')[0];
    const user = userId || getCurrentUser();

    const entries = database.prepare(`
        SELECT e.*, p.name as project_name
        FROM entries e
        JOIN projects p ON e.project_id = p.id
        WHERE date(e.created_at) = date(?) AND e.user_id = ?
        ORDER BY e.created_at DESC
    `).all(today, user);

    const projectSummary = {};
    let totalMinutes = 0;

    for (const entry of entries) {
        if (!projectSummary[entry.project_id]) {
            projectSummary[entry.project_id] = { name: entry.project_name, minutes: 0, entries: [] };
        }
        projectSummary[entry.project_id].minutes += entry.minutes;
        projectSummary[entry.project_id].entries.push(entry);
        totalMinutes += entry.minutes;
    }

    return {
        date: today,
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        projects: Object.entries(projectSummary).map(([id, data]) => ({
            id,
            name: data.name,
            minutes: data.minutes,
            durationFormatted: formatDuration(data.minutes),
            entries: data.entries
        }))
    };
}

export function getWeeklySummary(userId = null) {
    const database = getDb();
    const user = userId || getCurrentUser();
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const entries = database.prepare(`
        SELECT date(created_at) as day, SUM(minutes) as total
        FROM entries
        WHERE date(created_at) >= date(?) AND user_id = ?
        GROUP BY date(created_at)
        ORDER BY day
    `).all(weekAgo.toISOString().split('T')[0], user);

    let totalMinutes = 0;
    const days = entries.map(e => {
        totalMinutes += e.total;
        return {
            date: e.day,
            minutes: e.total,
            durationFormatted: formatDuration(e.total)
        };
    });

    return {
        weekStart: weekAgo.toISOString().split('T')[0],
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        days
    };
}

export function getUnbilledSummary(userId = null) {
    const database = getDb();
    const user = userId || getCurrentUser();

    const entries = database.prepare(`
        SELECT e.*, p.name as project_name
        FROM entries e
        JOIN projects p ON e.project_id = p.id
        WHERE e.billable = 1 AND e.billed = 0 AND e.user_id = ?
    `).all(user);

    const projectSummary = {};
    let totalMinutes = 0;

    for (const entry of entries) {
        if (!projectSummary[entry.project_id]) {
            projectSummary[entry.project_id] = { name: entry.project_name, minutes: 0, count: 0, entries: [] };
        }
        projectSummary[entry.project_id].minutes += entry.minutes;
        projectSummary[entry.project_id].count++;
        projectSummary[entry.project_id].entries.push(entry);
        totalMinutes += entry.minutes;
    }

    return {
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        projects: Object.entries(projectSummary).map(([id, data]) => ({
            id,
            name: data.name,
            minutes: data.minutes,
            durationFormatted: formatDuration(data.minutes),
            entryCount: data.count,
            entries: data.entries
        }))
    };
}

export function getUnbilledByClient(userId = null) {
    const database = getDb();
    const user = userId || getCurrentUser();

    const entries = database.prepare(`
        SELECT e.*, p.name as project_name, p.hourly_rate, c.id as client_id, c.name as client_name
        FROM entries e
        JOIN projects p ON e.project_id = p.id
        LEFT JOIN clients c ON p.client_id = c.id
        WHERE e.billable = 1 AND e.billed = 0 AND e.user_id = ?
    `).all(user);

    const clientSummary = {};
    let totalMinutes = 0;
    let totalValue = 0;

    for (const entry of entries) {
        const clientId = entry.client_id || 'no-client';
        const clientName = entry.client_name || 'No Client';

        if (!clientSummary[clientId]) {
            clientSummary[clientId] = {
                clientName,
                minutes: 0,
                value: 0,
                projects: {}
            };
        }

        if (!clientSummary[clientId].projects[entry.project_id]) {
            clientSummary[clientId].projects[entry.project_id] = {
                projectName: entry.project_name,
                hourlyRate: entry.hourly_rate || 0,
                minutes: 0
            };
        }

        clientSummary[clientId].minutes += entry.minutes;
        clientSummary[clientId].projects[entry.project_id].minutes += entry.minutes;

        const hours = entry.minutes / 60;
        const value = hours * (entry.hourly_rate || 0);
        clientSummary[clientId].value += value;
        totalValue += value;
        totalMinutes += entry.minutes;
    }

    return {
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        totalValue: totalValue.toFixed(2),
        clients: Object.entries(clientSummary).map(([id, data]) => ({
            clientId: id,
            clientName: data.clientName,
            minutes: data.minutes,
            durationFormatted: formatDuration(data.minutes),
            value: data.value,
            valueFormatted: data.value.toFixed(2),
            projects: Object.entries(data.projects).map(([pid, pdata]) => ({
                projectId: pid,
                projectName: pdata.projectName,
                hourlyRate: pdata.hourlyRate,
                minutes: pdata.minutes,
                durationFormatted: formatDuration(pdata.minutes),
                value: (pdata.minutes / 60) * pdata.hourlyRate,
                valueFormatted: ((pdata.minutes / 60) * pdata.hourlyRate).toFixed(2)
            }))
        }))
    };
}

// ==================== TIMER FUNCTIONS ====================

export function startTimer(projectName, description = '', userId = null) {
    const database = getDb();
    const project = getOrCreateProject(projectName);
    const user = userId || getCurrentUser();

    const existing = database.prepare('SELECT * FROM active_timer WHERE user_id = ?').get(user);
    if (existing && existing.project_id) {
        return { error: 'Timer already running', timer: existing };
    }

    database.prepare(`
        INSERT OR REPLACE INTO active_timer (user_id, project_id, description, started_at)
        VALUES (?, ?, ?, ?)
    `).run(user, project.id, description, new Date().toISOString());

    return { project: project.id, projectName: project.name, description, startedAt: new Date() };
}

export function stopTimer(message = null, billable = true, userId = null) {
    const database = getDb();
    const user = userId || getCurrentUser();
    const timer = database.prepare('SELECT * FROM active_timer WHERE user_id = ?').get(user);

    if (!timer || !timer.project_id) {
        return { error: 'No timer running' };
    }

    const startedAt = new Date(timer.started_at);
    const minutes = Math.round((Date.now() - startedAt.getTime()) / 60000);

    const entry = addEntry(timer.project_id, minutes, message || timer.description || 'Timer session', 'timer', billable, null, user);

    database.prepare('DELETE FROM active_timer WHERE user_id = ?').run(user);

    return {
        entry,
        minutes,
        duration: formatDuration(minutes),
        startedAt: timer.started_at
    };
}

export function getActiveTimer(userId = null) {
    const database = getDb();
    const user = userId || getCurrentUser();
    const timer = database.prepare(`
        SELECT t.*, p.name as project_name
        FROM active_timer t
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE t.user_id = ?
    `).get(user);

    if (!timer || !timer.project_id) return null;

    const startedAt = new Date(timer.started_at);
    const minutes = Math.round((Date.now() - startedAt.getTime()) / 60000);

    return {
        project: timer.project_id,
        projectName: timer.project_name,
        description: timer.description,
        startedAt: timer.started_at,
        runningMinutes: minutes,
        runningFormatted: formatDuration(minutes)
    };
}

export function cancelTimer(userId = null) {
    const database = getDb();
    const user = userId || getCurrentUser();
    const timer = database.prepare('SELECT * FROM active_timer WHERE user_id = ?').get(user);

    if (!timer || !timer.project_id) {
        return { error: 'No timer running' };
    }

    database.prepare('DELETE FROM active_timer WHERE user_id = ?').run(user);

    return { cancelled: true, project: timer.project_id };
}

// ==================== CLIENT FUNCTIONS ====================

export function createClient(name, email = '', notes = '') {
    const database = getDb();
    const id = name.toLowerCase().trim().replace(/\s+/g, '-');

    const existing = database.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (existing) {
        return { error: 'Client already exists', client: existing };
    }

    database.prepare(`
        INSERT INTO clients (id, name, email, notes) VALUES (?, ?, ?, ?)
    `).run(id, name, email, notes);

    return database.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

export function getClients() {
    const database = getDb();
    return database.prepare('SELECT * FROM clients ORDER BY name').all();
}

export function updateClient(clientId, updates) {
    const database = getDb();
    const sets = [];
    const values = [];

    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.email !== undefined) { sets.push('email = ?'); values.push(updates.email); }
    if (updates.notes !== undefined) { sets.push('notes = ?'); values.push(updates.notes); }

    if (sets.length > 0) {
        values.push(clientId);
        database.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    return database.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
}

export function deleteClient(clientId) {
    const database = getDb();
    const client = database.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);

    if (!client) return null;

    // Unlink projects from this client
    database.prepare('UPDATE projects SET client_id = NULL WHERE client_id = ?').run(clientId);
    database.prepare('DELETE FROM clients WHERE id = ?').run(clientId);

    return client;
}

// ==================== MEMORY FUNCTIONS (metadata only) ====================

export function saveMemory(id, content, metadata) {
    const database = getDb();

    database.prepare(`
        INSERT INTO memories (id, content, category, shared, project_id, client_id, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        content,
        metadata.category || '',
        metadata.shared ? 1 : 0,
        metadata.projectId || null,
        metadata.clientId || null,
        metadata.user || getCurrentUser()
    );

    return { id, content, ...metadata };
}

export function getMemories(options = {}) {
    const database = getDb();
    const userId = getCurrentUser();

    let query = 'SELECT * FROM memories WHERE (shared = 1 OR user_id = ?)';
    const params = [userId];

    if (options.category) {
        query += ' AND LOWER(category) = LOWER(?)';
        params.push(options.category);
    }
    if (options.project) {
        query += ' AND project_id = ?';
        params.push(options.project.toLowerCase().trim());
    }
    if (options.client) {
        query += ' AND client_id = ?';
        params.push(options.client.toLowerCase().trim().replace(/\s+/g, '-'));
    }
    if (options.personal) {
        query += ' AND shared = 0';
    }

    query += ' ORDER BY created_at DESC';

    return database.prepare(query).all(...params);
}

export function deleteMemoryFromDb(memoryId) {
    const database = getDb();
    const memory = database.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);

    if (!memory) return null;

    database.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);

    return memory;
}

// ==================== USER FUNCTIONS for Auth ====================

export function createUser(username, email, role = 'member', githubId = null) {
    const database = getDb();
    const id = username.toLowerCase().trim();

    try {
        const existing = database.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (existing) {
            return { error: 'User already exists', user: existing };
        }

        database.prepare(`
            INSERT INTO users (id, username, email, role, github_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, username, email, role, githubId, new Date().toISOString());

        return database.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } catch (err) {
        console.error('Error creating user:', err);
        return { error: err.message };
    }
}

export function getUser(identifier) {
    const database = getDb();
    if (!identifier) return null;

    // Try by ID (username)
    let user = database.prepare('SELECT * FROM users WHERE id = ?').get(identifier.toLowerCase());

    // Try by GitHub ID if not found and looks like an ID
    if (!user) {
        user = database.prepare('SELECT * FROM users WHERE github_id = ?').get(identifier);
    }

    return user;
}

export function getUsers() {
    const database = getDb();
    return database.prepare('SELECT * FROM users ORDER BY username').all();
}

export function updateUser(userId, updates) {
    const database = getDb();
    const sets = [];
    const values = [];

    if (updates.email !== undefined) { sets.push('email = ?'); values.push(updates.email); }
    if (updates.role !== undefined) { sets.push('role = ?'); values.push(updates.role); }
    if (updates.lastLogin !== undefined) { sets.push('last_login = ?'); values.push(updates.lastLogin); }
    if (updates.githubId !== undefined) { sets.push('github_id = ?'); values.push(updates.githubId); }

    if (sets.length > 0) {
        values.push(userId.toLowerCase());
        database.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    return database.prepare('SELECT * FROM users WHERE id = ?').get(userId.toLowerCase());
}

export function deleteUser(userId) {
    const database = getDb();
    const user = database.prepare('SELECT * FROM users WHERE id = ?').get(userId.toLowerCase());

    if (!user) return null;

    database.prepare('DELETE FROM users WHERE id = ?').run(userId.toLowerCase());
    return user;
}


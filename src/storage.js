import fs from 'fs';
import path from 'path';
import os from 'os';

// Store data in user's home directory for persistence
const DATA_DIR = path.join(os.homedir(), '.calq');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/**
 * Initialize the data directory and file if they don't exist
 */
function initStorage() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            clients: {},
            projects: {},
            entries: [],
            memories: [],
            activeTimer: null
        }, null, 2));
    }
}

/**
 * Load all data from the JSON file
 * @returns {Object} The stored data
 */
export function loadData() {
    initStorage();
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
}

/**
 * Save data to the JSON file
 * @param {Object} data - The data to save
 */
export function saveData(data) {
    initStorage();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Add a time entry to a project
 * @param {string} project - Project name
 * @param {number} minutes - Time in minutes
 * @param {string} description - Optional description
 * @param {string} type - Entry type: 'time' or 'commit'
 * @param {boolean} billable - Whether this entry is billable
 * @param {string} date - Optional date string (YYYY-MM-DD or ISO format)
 * @returns {Object} The created entry
 */
export function addEntry(project, minutes, description = '', type = 'time', billable = true, date = null) {
    const data = loadData();

    // Normalize project name (lowercase, trim)
    const normalizedProject = project.toLowerCase().trim();

    // Create or update project
    if (!data.projects[normalizedProject]) {
        data.projects[normalizedProject] = {
            name: project.trim(), // Keep original casing for display
            createdAt: new Date().toISOString(),
            totalMinutes: 0
        };
    }

    // Parse the date if provided
    let entryDate;
    if (date) {
        // Handle YYYY-MM-DD format by adding current time
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            entryDate = new Date(date + 'T12:00:00').toISOString();
        } else {
            entryDate = new Date(date).toISOString();
        }
    } else {
        entryDate = new Date().toISOString();
    }

    // Create entry
    const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        project: normalizedProject,
        minutes: minutes,
        description: description,
        type: type,
        billable: billable,
        billed: false,
        user: process.env.CALQ_USER || 'unknown',
        createdAt: entryDate
    };

    // Update totals and save
    data.projects[normalizedProject].totalMinutes += minutes;
    data.entries.push(entry);
    saveData(data);

    return entry;
}

/**
 * Get all projects with their totals
 * @returns {Array} List of projects with stats
 */
export function getProjects() {
    const data = loadData();
    return Object.entries(data.projects).map(([key, project]) => ({
        id: key,
        name: project.name,
        totalMinutes: project.totalMinutes,
        totalFormatted: formatDuration(project.totalMinutes),
        createdAt: project.createdAt
    }));
}

/**
 * Get entries for a specific project
 * @param {string} project - Project name
 * @param {number} limit - Maximum number of entries to return
 * @returns {Array} List of entries
 */
export function getProjectEntries(project, limit = 20) {
    const data = loadData();
    const normalizedProject = project.toLowerCase().trim();

    return data.entries
        .filter(entry => entry.project === normalizedProject)
        .slice(-limit)
        .reverse()
        .map(entry => ({
            ...entry,
            durationFormatted: formatDuration(entry.minutes)
        }));
}

/**
 * Get today's entries across all projects
 * @returns {Object} Today's summary
 */
export function getTodaySummary() {
    const data = loadData();
    const today = new Date().toISOString().split('T')[0];

    const todayEntries = data.entries.filter(entry =>
        entry.createdAt.startsWith(today)
    );

    // Group by project
    const byProject = {};
    let totalMinutes = 0;

    for (const entry of todayEntries) {
        if (!byProject[entry.project]) {
            byProject[entry.project] = {
                name: data.projects[entry.project]?.name || entry.project,
                minutes: 0,
                entries: []
            };
        }
        byProject[entry.project].minutes += entry.minutes;
        byProject[entry.project].entries.push(entry);
        totalMinutes += entry.minutes;
    }

    return {
        date: today,
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        projects: Object.values(byProject).map(p => ({
            ...p,
            durationFormatted: formatDuration(p.minutes)
        }))
    };
}

/**
 * Format minutes as human-readable duration
 * @param {number} minutes - Duration in minutes
 * @returns {string} Formatted duration
 */
export function formatDuration(minutes) {
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Get weekly summary
 * @returns {Object} This week's summary
 */
export function getWeeklySummary() {
    const data = loadData();
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
    weekStart.setHours(0, 0, 0, 0);

    const weekEntries = data.entries.filter(entry =>
        new Date(entry.createdAt) >= weekStart
    );

    // Group by day and project
    const byDay = {};
    let totalMinutes = 0;

    for (const entry of weekEntries) {
        const day = entry.createdAt.split('T')[0];
        if (!byDay[day]) {
            byDay[day] = { minutes: 0, entries: [] };
        }
        byDay[day].minutes += entry.minutes;
        byDay[day].entries.push(entry);
        totalMinutes += entry.minutes;
    }

    return {
        weekStart: weekStart.toISOString().split('T')[0],
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        days: Object.entries(byDay).map(([date, data]) => ({
            date,
            ...data,
            durationFormatted: formatDuration(data.minutes)
        }))
    };
}

/**
 * Delete an entry by ID, or the last entry if no ID provided
 * @param {string} entryId - Optional entry ID to delete
 * @returns {Object|null} The deleted entry, or null if not found
 */
export function deleteEntry(entryId = null) {
    const data = loadData();

    if (data.entries.length === 0) {
        return null;
    }

    let deletedEntry;
    let index;

    if (entryId) {
        index = data.entries.findIndex(e => e.id === entryId);
        if (index === -1) return null;
        deletedEntry = data.entries[index];
    } else {
        // Delete the last entry
        index = data.entries.length - 1;
        deletedEntry = data.entries[index];
    }

    // Remove from entries array
    data.entries.splice(index, 1);

    // Update project total
    if (data.projects[deletedEntry.project]) {
        data.projects[deletedEntry.project].totalMinutes -= deletedEntry.minutes;
    }

    saveData(data);
    return deletedEntry;
}

/**
 * Edit an existing entry
 * @param {string} entryId - Entry ID to edit
 * @param {Object} updates - Fields to update (project, minutes, message)
 * @returns {Object|null} The updated entry, or null if not found
 */
export function editEntry(entryId, updates) {
    const data = loadData();

    const index = data.entries.findIndex(e => e.id === entryId);
    if (index === -1) return null;

    const entry = data.entries[index];
    const oldProject = entry.project;
    const oldMinutes = entry.minutes;

    // Apply updates
    if (updates.message !== undefined) {
        entry.description = updates.message;
    }
    if (updates.minutes !== undefined) {
        entry.minutes = updates.minutes;
    }
    if (updates.project !== undefined) {
        const newProject = updates.project.toLowerCase().trim();

        // Create new project if it doesn't exist
        if (!data.projects[newProject]) {
            data.projects[newProject] = {
                name: updates.project.trim(),
                createdAt: new Date().toISOString(),
                totalMinutes: 0
            };
        }

        entry.project = newProject;
    }
    if (updates.billable !== undefined) {
        entry.billable = updates.billable;
    }
    if (updates.billed !== undefined) {
        entry.billed = updates.billed;
    }

    // Update project totals
    if (entry.project !== oldProject) {
        // Moved to different project
        data.projects[oldProject].totalMinutes -= oldMinutes;
        data.projects[entry.project].totalMinutes += entry.minutes;
    } else if (entry.minutes !== oldMinutes) {
        // Same project, different time
        data.projects[entry.project].totalMinutes += (entry.minutes - oldMinutes);
    }

    data.entries[index] = entry;
    saveData(data);

    return entry;
}

/**
 * Get the last entry
 * @returns {Object|null} The last entry, or null if none exist
 */
export function getLastEntry() {
    const data = loadData();
    if (data.entries.length === 0) return null;
    return data.entries[data.entries.length - 1];
}

/**
 * Get unbilled time summary
 * @returns {Object} Summary of unbilled billable time by project
 */
export function getUnbilledSummary() {
    const data = loadData();

    const unbilledByProject = {};
    let totalMinutes = 0;

    for (const entry of data.entries) {
        // Only count billable entries that haven't been billed
        if (entry.billable && !entry.billed && entry.minutes > 0) {
            const projectName = data.projects[entry.project]?.name || entry.project;
            if (!unbilledByProject[entry.project]) {
                unbilledByProject[entry.project] = {
                    name: projectName,
                    minutes: 0,
                    entries: []
                };
            }
            unbilledByProject[entry.project].minutes += entry.minutes;
            unbilledByProject[entry.project].entries.push(entry);
            totalMinutes += entry.minutes;
        }
    }

    return {
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        projects: Object.values(unbilledByProject).map(p => ({
            ...p,
            durationFormatted: formatDuration(p.minutes)
        }))
    };
}

/**
 * Start a timer for a project
 * @param {string} project - Project name
 * @param {string} description - What you're working on
 * @returns {Object} The timer object, or error if timer already running
 */
export function startTimer(project, description = '') {
    const data = loadData();

    if (data.activeTimer) {
        return { error: 'Timer already running', timer: data.activeTimer };
    }

    const timer = {
        project: project,
        description: description,
        startedAt: new Date().toISOString()
    };

    data.activeTimer = timer;
    saveData(data);

    return { timer };
}

/**
 * Stop the active timer and create an entry
 * @param {string} message - Final message/summary for the entry
 * @param {boolean} billable - Whether this is billable
 * @returns {Object} The created entry, or error if no timer
 */
export function stopTimer(message = null, billable = true) {
    const data = loadData();

    if (!data.activeTimer) {
        return { error: 'No timer running' };
    }

    const timer = data.activeTimer;
    const startTime = new Date(timer.startedAt);
    const endTime = new Date();
    const minutes = Math.round((endTime - startTime) / 60000);

    // Clear the timer
    data.activeTimer = null;
    saveData(data);

    // Create the entry
    const finalMessage = message || timer.description || 'Timed work';
    const entry = addEntry(timer.project, minutes, finalMessage, 'commit', billable);

    return { entry, minutes };
}

/**
 * Get the active timer if any
 * @returns {Object|null} The active timer or null
 */
export function getActiveTimer() {
    const data = loadData();

    if (!data.activeTimer) {
        return null;
    }

    const startTime = new Date(data.activeTimer.startedAt);
    const now = new Date();
    const elapsedMinutes = Math.round((now - startTime) / 60000);

    return {
        ...data.activeTimer,
        elapsedMinutes,
        elapsedFormatted: formatDuration(elapsedMinutes)
    };
}

/**
 * Cancel the active timer without saving
 * @returns {Object|null} The cancelled timer or null
 */
export function cancelTimer() {
    const data = loadData();

    if (!data.activeTimer) {
        return null;
    }

    const timer = data.activeTimer;
    data.activeTimer = null;
    saveData(data);

    return timer;
}

// ==================== CLIENT MANAGEMENT ====================

/**
 * Create a new client
 * @param {string} name - Client name
 * @param {string} email - Optional email
 * @param {string} notes - Optional notes
 * @returns {Object} The created client
 */
export function createClient(name, email = '', notes = '') {
    const data = loadData();

    if (!data.clients) data.clients = {};

    const id = name.toLowerCase().trim().replace(/\s+/g, '-');

    if (data.clients[id]) {
        return { error: 'Client already exists', client: data.clients[id] };
    }

    const client = {
        id: id,
        name: name.trim(),
        email: email,
        notes: notes,
        createdAt: new Date().toISOString()
    };

    data.clients[id] = client;
    saveData(data);

    return client;
}

/**
 * Get all clients
 * @returns {Array} List of clients
 */
export function getClients() {
    const data = loadData();
    return Object.values(data.clients || {});
}

/**
 * Get a client by ID or name
 * @param {string} identifier - Client ID or name
 * @returns {Object|null} The client or null
 */
export function getClient(identifier) {
    const data = loadData();
    const id = identifier.toLowerCase().trim().replace(/\s+/g, '-');
    return data.clients?.[id] || null;
}

/**
 * Update a client
 * @param {string} clientId - Client ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} Updated client or null
 */
export function updateClient(clientId, updates) {
    const data = loadData();
    const id = clientId.toLowerCase().trim().replace(/\s+/g, '-');

    if (!data.clients?.[id]) return null;

    if (updates.name) data.clients[id].name = updates.name;
    if (updates.email !== undefined) data.clients[id].email = updates.email;
    if (updates.notes !== undefined) data.clients[id].notes = updates.notes;

    saveData(data);
    return data.clients[id];
}

/**
 * Delete a client
 * @param {string} clientId - Client ID
 * @returns {Object|null} Deleted client or null
 */
export function deleteClient(clientId) {
    const data = loadData();
    const id = clientId.toLowerCase().trim().replace(/\s+/g, '-');

    if (!data.clients?.[id]) return null;

    const deleted = data.clients[id];
    delete data.clients[id];
    saveData(data);

    return deleted;
}

// ==================== PROJECT MANAGEMENT ====================

/**
 * Create or update a project with client link and hourly rate
 * @param {string} name - Project name
 * @param {string} clientId - Client ID to link
 * @param {number} hourlyRate - Hourly rate for billing
 * @param {string} notes - Optional notes
 * @returns {Object} The created/updated project
 */
export function createProject(name, clientId = null, hourlyRate = 0, notes = '') {
    const data = loadData();

    const id = name.toLowerCase().trim();

    // Check if project already exists
    if (data.projects[id]) {
        // Update existing project
        if (clientId) data.projects[id].clientId = clientId.toLowerCase().trim().replace(/\s+/g, '-');
        if (hourlyRate > 0) data.projects[id].hourlyRate = hourlyRate;
        if (notes) data.projects[id].notes = notes;
        saveData(data);
        return data.projects[id];
    }

    const project = {
        name: name.trim(),
        clientId: clientId ? clientId.toLowerCase().trim().replace(/\s+/g, '-') : null,
        hourlyRate: hourlyRate,
        notes: notes,
        createdAt: new Date().toISOString(),
        totalMinutes: 0
    };

    data.projects[id] = project;
    saveData(data);

    return project;
}

/**
 * Get projects with client info
 * @param {string} clientId - Optional filter by client
 * @returns {Array} List of projects with client info
 */
export function getProjectsWithClients(clientId = null) {
    const data = loadData();

    let projects = Object.entries(data.projects).map(([id, project]) => {
        const client = project.clientId ? data.clients?.[project.clientId] : null;
        return {
            id: id,
            ...project,
            clientName: client?.name || null,
            totalFormatted: formatDuration(project.totalMinutes || 0),
            estimatedValue: project.hourlyRate ? ((project.totalMinutes || 0) / 60 * project.hourlyRate).toFixed(2) : null
        };
    });

    if (clientId) {
        const normalizedClientId = clientId.toLowerCase().trim().replace(/\s+/g, '-');
        projects = projects.filter(p => p.clientId === normalizedClientId);
    }

    return projects;
}

/**
 * Update a project
 * @param {string} projectId - Project ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} Updated project or null
 */
export function updateProject(projectId, updates) {
    const data = loadData();
    const id = projectId.toLowerCase().trim();

    if (!data.projects?.[id]) return null;

    if (updates.name) data.projects[id].name = updates.name;
    if (updates.clientId !== undefined) {
        data.projects[id].clientId = updates.clientId ?
            updates.clientId.toLowerCase().trim().replace(/\s+/g, '-') : null;
    }
    if (updates.hourlyRate !== undefined) data.projects[id].hourlyRate = updates.hourlyRate;
    if (updates.notes !== undefined) data.projects[id].notes = updates.notes;

    saveData(data);
    return data.projects[id];
}

/**
 * Get unbilled summary with client grouping and values
 * @returns {Object} Enhanced unbilled summary
 */
export function getUnbilledByClient() {
    const data = loadData();

    const byClient = {};
    let totalMinutes = 0;
    let totalValue = 0;

    for (const entry of data.entries) {
        if (entry.billable && !entry.billed && entry.minutes > 0) {
            const project = data.projects[entry.project];
            const clientId = project?.clientId || 'no-client';
            const client = data.clients?.[clientId];
            const hourlyRate = project?.hourlyRate || 0;
            const value = (entry.minutes / 60) * hourlyRate;

            if (!byClient[clientId]) {
                byClient[clientId] = {
                    clientId: clientId,
                    clientName: client?.name || 'No Client',
                    minutes: 0,
                    value: 0,
                    projects: {}
                };
            }

            byClient[clientId].minutes += entry.minutes;
            byClient[clientId].value += value;

            if (!byClient[clientId].projects[entry.project]) {
                byClient[clientId].projects[entry.project] = {
                    projectName: project?.name || entry.project,
                    hourlyRate: hourlyRate,
                    minutes: 0,
                    value: 0,
                    entries: []
                };
            }

            byClient[clientId].projects[entry.project].minutes += entry.minutes;
            byClient[clientId].projects[entry.project].value += value;
            byClient[clientId].projects[entry.project].entries.push(entry);

            totalMinutes += entry.minutes;
            totalValue += value;
        }
    }

    return {
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        totalValue: totalValue.toFixed(2),
        clients: Object.values(byClient).map(c => ({
            ...c,
            durationFormatted: formatDuration(c.minutes),
            valueFormatted: c.value.toFixed(2),
            projects: Object.values(c.projects).map(p => ({
                ...p,
                durationFormatted: formatDuration(p.minutes),
                valueFormatted: p.value.toFixed(2)
            }))
        }))
    };
}

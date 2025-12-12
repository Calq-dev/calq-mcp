import { eq, and, or, ilike, sql, desc } from 'drizzle-orm';
import { db, users, clients, projects, entries, memories, activeTimer, tasks, observations, sessionSummaries } from './db/index.js';

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

export async function getOrCreateProject(projectName) {
    const id = projectName.toLowerCase().trim().replace(/\s+/g, '-');

    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);

    if (!project) {
        await db.insert(projects).values({
            id,
            name: projectName,
            totalMinutes: 0,
        });
        return { id, name: projectName, totalMinutes: 0 };
    }

    return project;
}

export async function getProjects() {
    const result = await db
        .select({
            id: projects.id,
            name: projects.name,
            clientId: projects.clientId,
            hourlyRate: projects.hourlyRate,
            notes: projects.notes,
            totalMinutes: projects.totalMinutes,
            createdAt: projects.createdAt,
            clientName: clients.name,
        })
        .from(projects)
        .leftJoin(clients, eq(projects.clientId, clients.id))
        .orderBy(desc(projects.totalMinutes));

    return result.map(p => ({
        ...p,
        total_minutes: p.totalMinutes,
        totalFormatted: formatDuration(p.totalMinutes || 0),
    }));
}

export async function getProjectsWithClients(clientFilter = null) {
    let query = db
        .select({
            id: projects.id,
            name: projects.name,
            clientId: projects.clientId,
            hourlyRate: projects.hourlyRate,
            notes: projects.notes,
            totalMinutes: projects.totalMinutes,
            createdAt: projects.createdAt,
            clientName: clients.name,
        })
        .from(projects)
        .leftJoin(clients, eq(projects.clientId, clients.id));

    if (clientFilter) {
        query = query.where(ilike(clients.name, `%${clientFilter}%`));
    }

    const result = await query;

    return result.map(p => ({
        ...p,
        total_minutes: p.totalMinutes,
        totalFormatted: formatDuration(p.totalMinutes || 0),
        estimatedValue: p.hourlyRate ? (((p.totalMinutes || 0) / 60) * p.hourlyRate).toFixed(2) : null,
    }));
}

export async function createProject(name, clientName = null, hourlyRate = 0, notes = '') {
    const id = name.toLowerCase().trim().replace(/\s+/g, '-');

    let clientId = null;
    if (clientName) {
        const [client] = await db
            .select({ id: clients.id })
            .from(clients)
            .where(ilike(clients.name, `%${clientName}%`))
            .limit(1);
        if (client) clientId = client.id;
    }

    const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);

    if (existing) {
        await db
            .update(projects)
            .set({ clientId, hourlyRate, notes })
            .where(eq(projects.id, id));
    } else {
        await db.insert(projects).values({
            id,
            name,
            clientId,
            hourlyRate,
            notes,
        });
    }

    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return project;
}

export async function updateProject(projectId, updates) {
    const setValues = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.clientId !== undefined) setValues.clientId = updates.clientId;
    if (updates.hourlyRate !== undefined) setValues.hourlyRate = updates.hourlyRate;
    if (updates.notes !== undefined) setValues.notes = updates.notes;

    if (Object.keys(setValues).length > 0) {
        await db.update(projects).set(setValues).where(eq(projects.id, projectId));
    }

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return project;
}

// ==================== ENTRY FUNCTIONS ====================

export async function addEntry(projectName, minutes, description, type = 'commit', billable = true, date = null, userId = null) {
    const project = await getOrCreateProject(projectName);
    const id = generateId();
    const user = userId || getCurrentUser();

    let createdAt;
    if (date) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            createdAt = new Date(date + 'T12:00:00.000Z');
        } else {
            createdAt = new Date(date);
        }
    } else {
        createdAt = new Date();
    }

    await db.insert(entries).values({
        id,
        projectId: project.id,
        minutes,
        description,
        type,
        billable,
        userId: user,
        createdAt,
    });

    // Update project total
    await db
        .update(projects)
        .set({ totalMinutes: sql`${projects.totalMinutes} + ${minutes}` })
        .where(eq(projects.id, project.id));

    const entry = { id, project: project.id, minutes, description, type, billable, userId: user, createdAt: createdAt.toISOString() };

    // Index in ChromaDB for semantic search (async, non-blocking)
    import('./memory.js').then(({ indexEntry }) => {
        indexEntry(entry).catch(() => {});
    }).catch(() => {});

    return entry;
}

export async function getProjectEntries(projectId, limit = 10) {
    const result = await db
        .select({
            id: entries.id,
            projectId: entries.projectId,
            minutes: entries.minutes,
            description: entries.description,
            type: entries.type,
            billable: entries.billable,
            billed: entries.billed,
            userId: entries.userId,
            createdAt: entries.createdAt,
            username: users.username,
        })
        .from(entries)
        .leftJoin(users, eq(entries.userId, users.id))
        .where(eq(entries.projectId, projectId.toLowerCase().trim().replace(/\s+/g, '-')))
        .orderBy(desc(entries.createdAt))
        .limit(limit);

    return result.map(e => ({
        ...e,
        durationFormatted: formatDuration(e.minutes),
    }));
}

export async function deleteEntry(entryId) {
    // If no entryId, get the last entry
    let entry;
    if (!entryId) {
        [entry] = await db.select().from(entries).orderBy(desc(entries.createdAt)).limit(1);
    } else {
        [entry] = await db.select().from(entries).where(eq(entries.id, entryId)).limit(1);
    }

    if (!entry) return null;

    // Update project total
    await db
        .update(projects)
        .set({ totalMinutes: sql`${projects.totalMinutes} - ${entry.minutes}` })
        .where(eq(projects.id, entry.projectId));

    await db.delete(entries).where(eq(entries.id, entry.id));

    // Remove from ChromaDB (async, non-blocking)
    import('./memory.js').then(({ deleteEntryFromChroma }) => {
        deleteEntryFromChroma(entry.id).catch(() => {});
    }).catch(() => {});

    return { ...entry, project: entry.projectId };
}

export async function editEntry(entryId, updates) {
    const [entry] = await db.select().from(entries).where(eq(entries.id, entryId)).limit(1);

    if (!entry) return null;

    const setValues = {};
    let minutesDiff = 0;

    if (updates.minutes !== undefined) {
        minutesDiff = updates.minutes - entry.minutes;
        setValues.minutes = updates.minutes;
    }
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.billable !== undefined) setValues.billable = updates.billable;
    if (updates.billed !== undefined) setValues.billed = updates.billed;

    if (Object.keys(setValues).length > 0) {
        await db.update(entries).set(setValues).where(eq(entries.id, entryId));

        if (minutesDiff !== 0) {
            await db
                .update(projects)
                .set({ totalMinutes: sql`${projects.totalMinutes} + ${minutesDiff}` })
                .where(eq(projects.id, entry.projectId));
        }
    }

    const [updated] = await db.select().from(entries).where(eq(entries.id, entryId)).limit(1);
    return { ...updated, project: updated.projectId };
}

export async function getLastEntry() {
    const [entry] = await db.select().from(entries).orderBy(desc(entries.createdAt)).limit(1);
    return entry;
}

// ==================== SUMMARY FUNCTIONS ====================

export async function getTodaySummary(userId = null) {
    const today = new Date().toISOString().split('T')[0];
    const user = userId || getCurrentUser();

    const result = await db
        .select({
            id: entries.id,
            projectId: entries.projectId,
            minutes: entries.minutes,
            description: entries.description,
            type: entries.type,
            billable: entries.billable,
            billed: entries.billed,
            createdAt: entries.createdAt,
            projectName: projects.name,
        })
        .from(entries)
        .innerJoin(projects, eq(entries.projectId, projects.id))
        .where(
            and(
                sql`date(${entries.createdAt}) = ${today}`,
                eq(entries.userId, user)
            )
        )
        .orderBy(desc(entries.createdAt));

    const projectSummary = {};
    let totalMinutes = 0;

    for (const entry of result) {
        if (!projectSummary[entry.projectId]) {
            projectSummary[entry.projectId] = { name: entry.projectName, minutes: 0, entries: [] };
        }
        projectSummary[entry.projectId].minutes += entry.minutes;
        projectSummary[entry.projectId].entries.push(entry);
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
            entries: data.entries,
        })),
    };
}

export async function getWeeklySummary(userId = null) {
    const user = userId || getCurrentUser();
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    const result = await db
        .select({
            day: sql`date(${entries.createdAt})`.as('day'),
            total: sql`sum(${entries.minutes})`.as('total'),
        })
        .from(entries)
        .where(
            and(
                sql`date(${entries.createdAt}) >= ${weekAgoStr}`,
                eq(entries.userId, user)
            )
        )
        .groupBy(sql`date(${entries.createdAt})`)
        .orderBy(sql`date(${entries.createdAt})`);

    let totalMinutes = 0;
    const days = result.map(e => {
        const dayTotal = Number(e.total) || 0;
        totalMinutes += dayTotal;
        return {
            date: e.day,
            minutes: dayTotal,
            durationFormatted: formatDuration(dayTotal),
        };
    });

    return {
        weekStart: weekAgoStr,
        totalMinutes,
        totalFormatted: formatDuration(totalMinutes),
        days,
    };
}

export async function getUnbilledSummary(userId = null) {
    const user = userId || getCurrentUser();

    const result = await db
        .select({
            id: entries.id,
            projectId: entries.projectId,
            minutes: entries.minutes,
            description: entries.description,
            type: entries.type,
            billable: entries.billable,
            billed: entries.billed,
            createdAt: entries.createdAt,
            projectName: projects.name,
        })
        .from(entries)
        .innerJoin(projects, eq(entries.projectId, projects.id))
        .where(
            and(
                eq(entries.billable, true),
                eq(entries.billed, false),
                eq(entries.userId, user)
            )
        );

    const projectSummary = {};
    let totalMinutes = 0;

    for (const entry of result) {
        if (!projectSummary[entry.projectId]) {
            projectSummary[entry.projectId] = { name: entry.projectName, minutes: 0, count: 0, entries: [] };
        }
        projectSummary[entry.projectId].minutes += entry.minutes;
        projectSummary[entry.projectId].count++;
        projectSummary[entry.projectId].entries.push(entry);
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
            entries: data.entries,
        })),
    };
}

export async function getUnbilledByClient(userId = null) {
    const user = userId || getCurrentUser();

    const result = await db
        .select({
            id: entries.id,
            projectId: entries.projectId,
            minutes: entries.minutes,
            description: entries.description,
            createdAt: entries.createdAt,
            projectName: projects.name,
            hourlyRate: projects.hourlyRate,
            clientId: clients.id,
            clientName: clients.name,
        })
        .from(entries)
        .innerJoin(projects, eq(entries.projectId, projects.id))
        .leftJoin(clients, eq(projects.clientId, clients.id))
        .where(
            and(
                eq(entries.billable, true),
                eq(entries.billed, false),
                eq(entries.userId, user)
            )
        );

    const clientSummary = {};
    let totalMinutes = 0;
    let totalValue = 0;

    for (const entry of result) {
        const clientId = entry.clientId || 'no-client';
        const clientName = entry.clientName || 'No Client';

        if (!clientSummary[clientId]) {
            clientSummary[clientId] = {
                clientName,
                minutes: 0,
                value: 0,
                projects: {},
            };
        }

        if (!clientSummary[clientId].projects[entry.projectId]) {
            clientSummary[clientId].projects[entry.projectId] = {
                projectName: entry.projectName,
                hourlyRate: entry.hourlyRate || 0,
                minutes: 0,
            };
        }

        clientSummary[clientId].minutes += entry.minutes;
        clientSummary[clientId].projects[entry.projectId].minutes += entry.minutes;

        const hours = entry.minutes / 60;
        const value = hours * (entry.hourlyRate || 0);
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
                valueFormatted: ((pdata.minutes / 60) * pdata.hourlyRate).toFixed(2),
            })),
        })),
    };
}

export async function getTeamTodaySummary() {
    const today = new Date().toISOString().split('T')[0];

    const result = await db
        .select({
            id: entries.id,
            projectId: entries.projectId,
            minutes: entries.minutes,
            description: entries.description,
            userId: entries.userId,
            createdAt: entries.createdAt,
            projectName: projects.name,
            username: users.username,
        })
        .from(entries)
        .innerJoin(projects, eq(entries.projectId, projects.id))
        .leftJoin(users, eq(entries.userId, users.id))
        .where(sql`date(${entries.createdAt}) = ${today}`)
        .orderBy(desc(entries.createdAt));

    // Group by user, then by project
    const userSummary = {};
    let teamTotalMinutes = 0;

    for (const entry of result) {
        const userId = entry.userId || 'unknown';
        const username = entry.username || userId;

        if (!userSummary[userId]) {
            userSummary[userId] = {
                username,
                totalMinutes: 0,
                projects: {},
            };
        }

        if (!userSummary[userId].projects[entry.projectId]) {
            userSummary[userId].projects[entry.projectId] = {
                name: entry.projectName,
                minutes: 0,
            };
        }

        userSummary[userId].projects[entry.projectId].minutes += entry.minutes;
        userSummary[userId].totalMinutes += entry.minutes;
        teamTotalMinutes += entry.minutes;
    }

    return {
        date: today,
        teamTotalMinutes,
        teamTotalFormatted: formatDuration(teamTotalMinutes),
        members: Object.entries(userSummary)
            .sort((a, b) => b[1].totalMinutes - a[1].totalMinutes) // Sort by most time logged
            .map(([userId, data]) => ({
                userId,
                username: data.username,
                totalMinutes: data.totalMinutes,
                totalFormatted: formatDuration(data.totalMinutes),
                projects: Object.entries(data.projects)
                    .sort((a, b) => b[1].minutes - a[1].minutes) // Sort by most time
                    .map(([projectId, pdata]) => ({
                        id: projectId,
                        name: pdata.name,
                        minutes: pdata.minutes,
                        durationFormatted: formatDuration(pdata.minutes),
                    })),
            })),
    };
}

// ==================== TIMER FUNCTIONS ====================

export async function startTimer(projectName, description = '', userId = null) {
    const project = await getOrCreateProject(projectName);
    const user = userId || getCurrentUser();

    const [existing] = await db.select().from(activeTimer).where(eq(activeTimer.userId, user)).limit(1);
    if (existing && existing.projectId) {
        return { error: 'Timer already running', timer: existing };
    }

    await db
        .insert(activeTimer)
        .values({
            userId: user,
            projectId: project.id,
            description,
            startedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: activeTimer.userId,
            set: {
                projectId: project.id,
                description,
                startedAt: new Date(),
            },
        });

    return { project: project.id, projectName: project.name, description, startedAt: new Date() };
}

export async function stopTimer(message = null, billable = true, userId = null) {
    const user = userId || getCurrentUser();
    const [timer] = await db.select().from(activeTimer).where(eq(activeTimer.userId, user)).limit(1);

    if (!timer || !timer.projectId) {
        return { error: 'No timer running' };
    }

    const startedAt = new Date(timer.startedAt);
    let totalElapsed = Math.round((Date.now() - startedAt.getTime()) / 60000);

    // If currently paused, add the current pause duration
    let currentPauseMinutes = 0;
    if (timer.pausedAt) {
        currentPauseMinutes = Math.round((Date.now() - new Date(timer.pausedAt).getTime()) / 60000);
    }

    // Subtract all paused time from total elapsed
    const totalPausedMinutes = (timer.pausedDuration || 0) + currentPauseMinutes;
    const minutes = Math.max(0, totalElapsed - totalPausedMinutes);

    const entry = await addEntry(timer.projectId, minutes, message || timer.description || 'Timer session', 'timer', billable, null, user);

    await db.delete(activeTimer).where(eq(activeTimer.userId, user));

    return {
        entry,
        minutes,
        duration: formatDuration(minutes),
        startedAt: timer.startedAt,
        pausedMinutes: totalPausedMinutes,
    };
}

export async function getActiveTimer(userId = null) {
    const user = userId || getCurrentUser();

    const result = await db
        .select({
            userId: activeTimer.userId,
            projectId: activeTimer.projectId,
            description: activeTimer.description,
            startedAt: activeTimer.startedAt,
            pausedAt: activeTimer.pausedAt,
            pausedDuration: activeTimer.pausedDuration,
            projectName: projects.name,
        })
        .from(activeTimer)
        .leftJoin(projects, eq(activeTimer.projectId, projects.id))
        .where(eq(activeTimer.userId, user))
        .limit(1);

    const [timer] = result;
    if (!timer || !timer.projectId) return null;

    const startedAt = new Date(timer.startedAt);
    const totalElapsed = Math.round((Date.now() - startedAt.getTime()) / 60000);

    // Calculate effective running time (excluding pauses)
    let currentPauseMinutes = 0;
    if (timer.pausedAt) {
        currentPauseMinutes = Math.round((Date.now() - new Date(timer.pausedAt).getTime()) / 60000);
    }
    const totalPausedMinutes = (timer.pausedDuration || 0) + currentPauseMinutes;
    const effectiveMinutes = Math.max(0, totalElapsed - totalPausedMinutes);

    return {
        project: timer.projectId,
        projectName: timer.projectName,
        description: timer.description,
        startedAt: timer.startedAt,
        isPaused: !!timer.pausedAt,
        pausedAt: timer.pausedAt,
        pausedDuration: timer.pausedDuration || 0,
        currentPauseMinutes,
        totalPausedMinutes,
        runningMinutes: effectiveMinutes,
        runningFormatted: formatDuration(effectiveMinutes),
        elapsedFormatted: formatDuration(effectiveMinutes),
    };
}

export async function cancelTimer(userId = null) {
    const user = userId || getCurrentUser();
    const [timer] = await db.select().from(activeTimer).where(eq(activeTimer.userId, user)).limit(1);

    if (!timer || !timer.projectId) {
        return { error: 'No timer running' };
    }

    await db.delete(activeTimer).where(eq(activeTimer.userId, user));

    return { cancelled: true, project: timer.projectId };
}

export async function pauseTimer(userId = null) {
    const user = userId || getCurrentUser();
    const [timer] = await db.select().from(activeTimer).where(eq(activeTimer.userId, user)).limit(1);

    if (!timer || !timer.projectId) {
        return { error: 'No timer running' };
    }

    if (timer.pausedAt) {
        return { error: 'Timer already paused', timer };
    }

    await db
        .update(activeTimer)
        .set({ pausedAt: new Date() })
        .where(eq(activeTimer.userId, user));

    const startedAt = new Date(timer.startedAt);
    const runningMinutes = Math.round((Date.now() - startedAt.getTime()) / 60000) - (timer.pausedDuration || 0);

    return {
        paused: true,
        project: timer.projectId,
        runningMinutes,
        runningFormatted: formatDuration(runningMinutes),
    };
}

export async function resumeTimer(userId = null) {
    const user = userId || getCurrentUser();
    const [timer] = await db.select().from(activeTimer).where(eq(activeTimer.userId, user)).limit(1);

    if (!timer || !timer.projectId) {
        return { error: 'No timer running' };
    }

    if (!timer.pausedAt) {
        return { error: 'Timer is not paused', timer };
    }

    // Calculate how long it was paused
    const pausedAt = new Date(timer.pausedAt);
    const pausedMinutes = Math.round((Date.now() - pausedAt.getTime()) / 60000);
    const totalPausedDuration = (timer.pausedDuration || 0) + pausedMinutes;

    await db
        .update(activeTimer)
        .set({
            pausedAt: null,
            pausedDuration: totalPausedDuration,
        })
        .where(eq(activeTimer.userId, user));

    return {
        resumed: true,
        project: timer.projectId,
        pausedMinutes,
        totalPausedDuration,
    };
}

// ==================== CLIENT FUNCTIONS ====================

export async function createClient(name, email = '', notes = '') {
    const id = name.toLowerCase().trim().replace(/\s+/g, '-');

    const [existing] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
    if (existing) {
        return { error: 'Client already exists', client: existing };
    }

    await db.insert(clients).values({
        id,
        name,
        email,
        notes,
    });

    const [client] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
    return client;
}

export async function getClients() {
    return await db.select().from(clients).orderBy(clients.name);
}

export async function updateClient(clientId, updates) {
    const setValues = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.email !== undefined) setValues.email = updates.email;
    if (updates.notes !== undefined) setValues.notes = updates.notes;

    if (Object.keys(setValues).length > 0) {
        await db.update(clients).set(setValues).where(eq(clients.id, clientId));
    }

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    return client;
}

export async function deleteClient(clientId) {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);

    if (!client) return null;

    // Unlink projects from this client
    await db.update(projects).set({ clientId: null }).where(eq(projects.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));

    return client;
}

// ==================== MEMORY FUNCTIONS (metadata only) ====================

export async function saveMemory(id, content, metadata) {
    await db.insert(memories).values({
        id,
        content,
        category: metadata.category || '',
        shared: metadata.shared !== false,
        projectId: metadata.projectId || null,
        clientId: metadata.clientId || null,
        userId: metadata.user || getCurrentUser(),
    });

    return { id, content, ...metadata };
}

export async function getMemories(options = {}) {
    const userId = getCurrentUser();

    let conditions = [
        or(
            eq(memories.shared, true),
            eq(memories.userId, userId)
        ),
    ];

    if (options.category) {
        conditions.push(ilike(memories.category, options.category));
    }
    if (options.project) {
        conditions.push(eq(memories.projectId, options.project.toLowerCase().trim()));
    }
    if (options.client) {
        conditions.push(eq(memories.clientId, options.client.toLowerCase().trim().replace(/\s+/g, '-')));
    }
    if (options.personal) {
        conditions.push(eq(memories.shared, false));
    }

    const result = await db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(desc(memories.createdAt));

    return result;
}

export async function deleteMemoryFromDb(memoryId) {
    const [memory] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);

    if (!memory) return null;

    await db.delete(memories).where(eq(memories.id, memoryId));

    return memory;
}

// ==================== USER FUNCTIONS for Auth ====================

export async function createUser(username, email, role = 'member', githubId = null) {
    const id = username.toLowerCase().trim();

    try {
        const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (existing) {
            return { error: 'User already exists', user: existing };
        }

        await db.insert(users).values({
            id,
            username,
            email,
            role,
            githubId,
            createdAt: new Date(),
        });

        const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        return user;
    } catch (err) {
        console.error('Error creating user:', err);
        return { error: err.message };
    }
}

export async function getUser(identifier) {
    if (!identifier) return null;

    // Try by ID (username)
    let [user] = await db.select().from(users).where(eq(users.id, identifier.toLowerCase())).limit(1);

    // Try by GitHub ID if not found
    if (!user) {
        [user] = await db.select().from(users).where(eq(users.githubId, identifier)).limit(1);
    }

    return user || null;
}

export async function getUsers() {
    return await db.select().from(users).orderBy(users.username);
}

export async function updateUser(userId, updates) {
    const setValues = {};
    if (updates.email !== undefined) setValues.email = updates.email;
    if (updates.role !== undefined) setValues.role = updates.role;
    if (updates.lastLogin !== undefined) setValues.lastLogin = new Date(updates.lastLogin);
    if (updates.githubId !== undefined) setValues.githubId = updates.githubId;

    if (Object.keys(setValues).length > 0) {
        await db.update(users).set(setValues).where(eq(users.id, userId.toLowerCase()));
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId.toLowerCase())).limit(1);
    return user;
}

export async function deleteUser(userId) {
    const [user] = await db.select().from(users).where(eq(users.id, userId.toLowerCase())).limit(1);

    if (!user) return null;

    await db.delete(users).where(eq(users.id, userId.toLowerCase()));
    return user;
}

// ==================== TASK FUNCTIONS ====================

export async function createTask(title, projectName = null, youtrackId = null, userId = null) {
    const id = generateId();
    const user = userId || getCurrentUser();

    let projectId = null;
    if (projectName) {
        const project = await getOrCreateProject(projectName);
        projectId = project.id;
    }

    await db.insert(tasks).values({
        id,
        title,
        userId: user,
        projectId,
        youtrackId,
        status: 'open',
    });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return task;
}

export async function getTasks(options = {}) {
    const userId = getCurrentUser();
    let conditions = [];

    // Filter by status
    if (options.status && options.status !== 'all') {
        conditions.push(eq(tasks.status, options.status));
    }

    // Filter by project
    if (options.project) {
        const projectId = options.project.toLowerCase().trim().replace(/\s+/g, '-');
        conditions.push(eq(tasks.projectId, projectId));
    }

    // Filter by user (mine only)
    if (options.mine) {
        conditions.push(eq(tasks.userId, userId));
    }

    const result = await db
        .select({
            id: tasks.id,
            title: tasks.title,
            description: tasks.description,
            userId: tasks.userId,
            projectId: tasks.projectId,
            youtrackId: tasks.youtrackId,
            status: tasks.status,
            syncedAt: tasks.syncedAt,
            createdAt: tasks.createdAt,
            completedAt: tasks.completedAt,
            projectName: projects.name,
            username: users.username,
        })
        .from(tasks)
        .leftJoin(projects, eq(tasks.projectId, projects.id))
        .leftJoin(users, eq(tasks.userId, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tasks.createdAt));

    return result;
}

export async function getTask(taskId) {
    const [task] = await db
        .select({
            id: tasks.id,
            title: tasks.title,
            description: tasks.description,
            userId: tasks.userId,
            projectId: tasks.projectId,
            youtrackId: tasks.youtrackId,
            status: tasks.status,
            syncedAt: tasks.syncedAt,
            createdAt: tasks.createdAt,
            completedAt: tasks.completedAt,
            projectName: projects.name,
            username: users.username,
        })
        .from(tasks)
        .leftJoin(projects, eq(tasks.projectId, projects.id))
        .leftJoin(users, eq(tasks.userId, users.id))
        .where(eq(tasks.id, taskId))
        .limit(1);

    return task || null;
}

export async function getTaskByYoutrackId(youtrackId) {
    const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.youtrackId, youtrackId))
        .limit(1);

    return task || null;
}

export async function completeTask(taskId, userId = null) {
    const user = userId || getCurrentUser();
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

    if (!task) {
        return { error: 'Task not found' };
    }

    if (task.status === 'done') {
        return { error: 'Task already completed', task };
    }

    await db
        .update(tasks)
        .set({
            status: 'done',
            completedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

    const [updated] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return updated;
}

export async function updateTask(taskId, updates) {
    const setValues = {};
    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.status !== undefined) setValues.status = updates.status;
    if (updates.projectId !== undefined) setValues.projectId = updates.projectId;
    if (updates.youtrackId !== undefined) setValues.youtrackId = updates.youtrackId;
    if (updates.syncedAt !== undefined) setValues.syncedAt = updates.syncedAt;
    if (updates.completedAt !== undefined) setValues.completedAt = updates.completedAt;

    if (Object.keys(setValues).length > 0) {
        await db.update(tasks).set(setValues).where(eq(tasks.id, taskId));
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return task;
}

export async function upsertTaskFromYouTrack(youtrackId, title, description, status, projectName = null, userId = null) {
    // Resolve project name to project ID if provided
    let projectId = null;
    if (projectName) {
        const project = await getOrCreateProject(projectName);
        projectId = project.id;
    }

    const existing = await getTaskByYoutrackId(youtrackId);

    if (existing) {
        // Update existing task
        return await updateTask(existing.id, {
            title,
            description,
            status,
            projectId,
            syncedAt: new Date(),
        });
    } else {
        // Create new task
        const id = generateId();
        const user = userId || getCurrentUser();

        await db.insert(tasks).values({
            id,
            title,
            description,
            userId: user,
            projectId,
            youtrackId,
            status,
            syncedAt: new Date(),
        });

        const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
        return task;
    }
}

export async function deleteTask(taskId) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

    if (!task) return null;

    await db.delete(tasks).where(eq(tasks.id, taskId));
    return task;
}

// ==================== USER YOUTRACK TOKEN ====================

export async function setUserYouTrackToken(userId, token) {
    await db
        .update(users)
        .set({ youtrackToken: token })
        .where(eq(users.id, userId.toLowerCase()));

    const [user] = await db.select().from(users).where(eq(users.id, userId.toLowerCase())).limit(1);
    return user;
}

export async function getUserYouTrackToken(userId) {
    const [user] = await db.select().from(users).where(eq(users.id, userId.toLowerCase())).limit(1);
    return user?.youtrackToken || null;
}

// ==================== OBSERVATIONS ====================

export async function createObservation({
    sessionId,
    userId,
    project,
    type,
    title,
    subtitle,
    narrative,
    facts,
    concepts,
    filesRead,
    filesModified,
    toolName,
    toolInput,
    discoveryTokens
}) {
    const id = generateId();

    await db.insert(observations).values({
        id,
        sessionId,
        userId,
        project,
        type,
        title,
        subtitle,
        narrative,
        facts: facts ? JSON.stringify(facts) : null,
        concepts: concepts ? JSON.stringify(concepts) : null,
        filesRead: filesRead ? JSON.stringify(filesRead) : null,
        filesModified: filesModified ? JSON.stringify(filesModified) : null,
        toolName,
        toolInput,
        discoveryTokens,
    });

    const [observation] = await db.select().from(observations).where(eq(observations.id, id)).limit(1);
    return observation;
}

export async function getObservations({ project, type, userId, limit = 50, offset = 0 } = {}) {
    let query = db.select().from(observations);

    const conditions = [];
    if (project) conditions.push(eq(observations.project, project));
    if (type) conditions.push(eq(observations.type, type));
    if (userId) conditions.push(eq(observations.userId, userId));

    if (conditions.length > 0) {
        query = query.where(and(...conditions));
    }

    const results = await query
        .orderBy(desc(observations.createdAt))
        .limit(limit)
        .offset(offset);

    return results.map(obs => ({
        ...obs,
        facts: obs.facts ? JSON.parse(obs.facts) : [],
        concepts: obs.concepts ? JSON.parse(obs.concepts) : [],
        filesRead: obs.filesRead ? JSON.parse(obs.filesRead) : [],
        filesModified: obs.filesModified ? JSON.parse(obs.filesModified) : [],
    }));
}

export async function searchObservations(query, { project, type, userId, limit = 20 } = {}) {
    // Simple text search on title, subtitle, narrative
    let dbQuery = db.select().from(observations);

    const conditions = [
        or(
            ilike(observations.title, `%${query}%`),
            ilike(observations.subtitle, `%${query}%`),
            ilike(observations.narrative, `%${query}%`)
        )
    ];

    if (project) conditions.push(eq(observations.project, project));
    if (type) conditions.push(eq(observations.type, type));
    if (userId) conditions.push(eq(observations.userId, userId));

    const results = await dbQuery
        .where(and(...conditions))
        .orderBy(desc(observations.createdAt))
        .limit(limit);

    return results.map(obs => ({
        ...obs,
        facts: obs.facts ? JSON.parse(obs.facts) : [],
        concepts: obs.concepts ? JSON.parse(obs.concepts) : [],
        filesRead: obs.filesRead ? JSON.parse(obs.filesRead) : [],
        filesModified: obs.filesModified ? JSON.parse(obs.filesModified) : [],
    }));
}

// ==================== SESSION SUMMARIES ====================

export async function createSessionSummary({
    sessionId,
    userId,
    project,
    request,
    investigated,
    learned,
    completed,
    nextSteps,
    notes,
    filesRead,
    filesEdited,
    discoveryTokens
}) {
    const id = generateId();

    // Upsert - update if session already has a summary
    const existing = await db.select().from(sessionSummaries).where(eq(sessionSummaries.sessionId, sessionId)).limit(1);

    if (existing.length > 0) {
        await db.update(sessionSummaries)
            .set({
                request,
                investigated,
                learned,
                completed,
                nextSteps,
                notes,
                filesRead: filesRead ? JSON.stringify(filesRead) : null,
                filesEdited: filesEdited ? JSON.stringify(filesEdited) : null,
                discoveryTokens,
            })
            .where(eq(sessionSummaries.sessionId, sessionId));

        const [summary] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.sessionId, sessionId)).limit(1);
        return summary;
    }

    await db.insert(sessionSummaries).values({
        id,
        sessionId,
        userId,
        project,
        request,
        investigated,
        learned,
        completed,
        nextSteps,
        notes,
        filesRead: filesRead ? JSON.stringify(filesRead) : null,
        filesEdited: filesEdited ? JSON.stringify(filesEdited) : null,
        discoveryTokens,
    });

    const [summary] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.id, id)).limit(1);
    return summary;
}

export async function getSessionSummaries({ project, userId, limit = 10 } = {}) {
    let query = db.select().from(sessionSummaries);

    const conditions = [];
    if (project) conditions.push(eq(sessionSummaries.project, project));
    if (userId) conditions.push(eq(sessionSummaries.userId, userId));

    if (conditions.length > 0) {
        query = query.where(and(...conditions));
    }

    const results = await query
        .orderBy(desc(sessionSummaries.createdAt))
        .limit(limit);

    return results.map(s => ({
        ...s,
        filesRead: s.filesRead ? JSON.parse(s.filesRead) : [],
        filesEdited: s.filesEdited ? JSON.parse(s.filesEdited) : [],
    }));
}

export async function getSessionSummary(sessionId) {
    const [summary] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.sessionId, sessionId)).limit(1);
    if (!summary) return null;

    return {
        ...summary,
        filesRead: summary.filesRead ? JSON.parse(summary.filesRead) : [],
        filesEdited: summary.filesEdited ? JSON.parse(summary.filesEdited) : [],
    };
}

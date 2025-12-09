import { eq, and, or, like, ilike, sql, desc, gte } from 'drizzle-orm';
import { db, users, clients, projects, entries, memories, activeTimer } from './db/index.js';

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
    const minutes = Math.round((Date.now() - startedAt.getTime()) / 60000);

    const entry = await addEntry(timer.projectId, minutes, message || timer.description || 'Timer session', 'timer', billable, null, user);

    await db.delete(activeTimer).where(eq(activeTimer.userId, user));

    return {
        entry,
        minutes,
        duration: formatDuration(minutes),
        startedAt: timer.startedAt,
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
            projectName: projects.name,
        })
        .from(activeTimer)
        .leftJoin(projects, eq(activeTimer.projectId, projects.id))
        .where(eq(activeTimer.userId, user))
        .limit(1);

    const [timer] = result;
    if (!timer || !timer.projectId) return null;

    const startedAt = new Date(timer.startedAt);
    const minutes = Math.round((Date.now() - startedAt.getTime()) / 60000);

    return {
        project: timer.projectId,
        projectName: timer.projectName,
        description: timer.description,
        startedAt: timer.startedAt,
        runningMinutes: minutes,
        runningFormatted: formatDuration(minutes),
        elapsedFormatted: formatDuration(minutes),
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

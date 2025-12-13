#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { z } from 'zod';
import {
    addEntry,
    getProjects,
    getProjectEntries,
    getTodaySummary,
    getWeeklySummary,
    getTeamTodaySummary,
    formatDuration,
    deleteEntry,
    editEntry,
    getLastEntry,
    getUnbilledSummary,
    startTimer,
    stopTimer,
    getActiveTimer,
    cancelTimer,
    pauseTimer,
    resumeTimer,
    createClient,
    getClients,
    updateClient,
    deleteClient,
    createProject,
    getProjectsWithClients,
    updateProject,
    getUnbilledByClient,
    getUser,
    getEntityCounts,
    // Task functions
    createTask,
    getTasks,
    getTask,
    completeTask,
    upsertTaskFromYouTrack,
    // YouTrack token functions
    setUserYouTrackToken,
    getUserYouTrackToken,
    // Observation functions
    createObservation,
    getObservations,
    searchObservations,
    createSessionSummary,
    getSessionSummaries,
    getSessionSummary,
    // Component registry functions
    publishComponent,
    getComponents,
    getComponent,
    deleteComponent
} from './storage.js';
import { getYouTrackClient, mapYouTrackStateToStatus } from './youtrack.js';
import {
    storeMemory,
    searchMemories,
    searchEntries,
    deleteMemory,
    getAllMemories
} from './memory.js';
import {
    getUsers,
    updateUser as updateUserAuth,
    deleteUser as deleteUserAuth
} from './auth.js';
import { oauthProvider } from './oauth-provider.js';

// Request context for passing authenticated user to tool handlers
const requestContext = new AsyncLocalStorage();

// Get the current authenticated user from request context
function getCurrentUser() {
    const store = requestContext.getStore();
    return store?.user || null;
}

// Helper to check user before tool execution
function checkUser() {
    const user = getCurrentUser();
    if (!user) {
        return { error: 'Not authenticated. Please complete OAuth login first.' };
    }
    return { user };
}

// Create the MCP server
const server = new McpServer({
    name: 'calq',
    version: '1.0.0',
    description: 'Time tracking, project management, and memory for teams'
});

// Tool: Log time to a project
server.tool(
    'log_time',
    {
        project: z.string().describe('Name of the project'),
        message: z.string().describe('What was accomplished'),
        minutes: z.number().nonnegative().optional().describe('Time spent in minutes (defaults to 0)'),
        billable: z.boolean().optional().describe('Whether this is billable work (defaults to true)'),
        date: z.string().optional().describe('Date for the entry (YYYY-MM-DD format). Defaults to today.'),
        task: z.string().optional().describe('Task ID to link this time entry to (syncs to YouTrack if linked)')
    },
    async ({ project, message, minutes, billable, date, task }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const entry = await addEntry(project, minutes || 0, message, 'commit', billable !== false, date || null, auth.user.id);

        let text = `📌 **${project}**\n\n${message}`;
        if (minutes) {
            text += `\n\n⏱️ ${formatDuration(minutes)}`;
        }
        if (date) {
            text += `\n📅 ${date}`;
        }
        if (billable === false) {
            text += `\n🏷️ Non-billable`;
        }

        // If task specified, sync time to YouTrack
        if (task && minutes && minutes > 0) {
            const taskData = await getTask(task);
            if (taskData && taskData.youtrackId) {
                try {
                    const token = await getUserYouTrackToken(auth.user.id);
                    if (token) {
                        const yt = getYouTrackClient(token);
                        await yt.addWorkItem(taskData.youtrackId, minutes, message, date || null);
                        text += `\n🔗 Synced to YouTrack ${taskData.youtrackId}`;
                    }
                } catch (error) {
                    text += `\n⚠️ YouTrack sync failed: ${error.message}`;
                }
            } else if (taskData) {
                text += `\n📋 Linked to task: ${taskData.title}`;
            }
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Manage time entries (edit/delete)
server.tool(
    'entry_manage',
    {
        action: z.enum(['edit', 'delete']).describe('Action to perform'),
        entry_id: z.string().optional().describe('ID of the entry (defaults to last entry for delete)'),
        message: z.string().optional().describe('New message (for edit)'),
        minutes: z.number().nonnegative().optional().describe('New time in minutes (for edit)'),
        billable: z.boolean().optional().describe('Set billable status (for edit)'),
        billed: z.boolean().optional().describe('Mark as billed/unbilled (for edit)')
    },
    async ({ action, entry_id, message, minutes, billable, billed }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        if (action === 'delete') {
            const deleted = await deleteEntry(entry_id || null);
            if (!deleted) {
                return { content: [{ type: 'text', text: '❌ No entry found to delete.' }] };
            }
            return {
                content: [{
                    type: 'text',
                    text: `🗑️ Deleted entry from **${deleted.project}**\n\n${deleted.description || '(no message)'}\n⏱️ ${formatDuration(deleted.minutes)}`
                }]
            };
        }

        if (action === 'edit') {
            if (!entry_id) {
                return { content: [{ type: 'text', text: '❌ entry_id is required for edit action.' }] };
            }
            if (!message && minutes === undefined && billable === undefined && billed === undefined) {
                return { content: [{ type: 'text', text: '❌ Provide at least one field to update.' }] };
            }

            const updates = {};
            if (message) updates.description = message;
            if (minutes !== undefined) updates.minutes = minutes;
            if (billable !== undefined) updates.billable = billable;
            if (billed !== undefined) updates.billed = billed;

            const updated = await editEntry(entry_id, updates);
            if (!updated) {
                return { content: [{ type: 'text', text: `❌ Entry "${entry_id}" not found.` }] };
            }

            let status = [];
            if (updated.billable) status.push('billable');
            if (updated.billed) status.push('billed');
            const statusText = status.length ? ` (${status.join(', ')})` : '';

            return {
                content: [{
                    type: 'text',
                    text: `✏️ Updated entry in **${updated.project}**${statusText}\n\n${updated.description}\n⏱️ ${formatDuration(updated.minutes)}`
                }]
            };
        }

        return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
    }
);

// Tool: Query time summaries
server.tool(
    'time_query',
    {
        scope: z.enum(['today', 'week', 'unbilled', 'invoice', 'team', 'project']).describe('What to query'),
        project: z.string().optional().describe('Project name (required for scope=project)'),
        limit: z.number().positive().optional().describe('Number of entries to show (for project scope, default: 10)')
    },
    async ({ scope, project, limit }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        // TODAY
        if (scope === 'today') {
            const summary = await getTodaySummary(auth.user.id);
            if (summary.projects.length === 0) {
                return { content: [{ type: 'text', text: `📅 **Today (${summary.date})**\n\n_No time logged today yet._` }] };
            }
            let text = `📅 **Today (${summary.date})**\n⏱️ Total: ${summary.totalFormatted}\n\n`;
            for (const proj of summary.projects) {
                text += `**${proj.name}**: ${proj.durationFormatted}\n`;
                for (const entry of proj.entries) {
                    text += `  • ${entry.description || '(no description)'}\n`;
                }
                text += '\n';
            }
            return { content: [{ type: 'text', text }] };
        }

        // WEEK
        if (scope === 'week') {
            const summary = await getWeeklySummary(auth.user.id);
            if (summary.days.length === 0) {
                return { content: [{ type: 'text', text: `📆 **This Week**\n\n_No time logged this week yet._` }] };
            }
            let text = `📆 **This Week** (starting ${summary.weekStart})\n⏱️ Total: ${summary.totalFormatted}\n\n`;
            for (const day of summary.days.sort((a, b) => a.date.localeCompare(b.date))) {
                const dayName = new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' });
                text += `**${dayName} (${day.date})**: ${day.durationFormatted}\n`;
            }
            return { content: [{ type: 'text', text }] };
        }

        // UNBILLED
        if (scope === 'unbilled') {
            const summary = await getUnbilledSummary(auth.user.id);
            if (summary.projects.length === 0) {
                return { content: [{ type: 'text', text: `💰 **Unbilled Time**\n\n_No unbilled billable time._` }] };
            }
            let text = `💰 **Unbilled Time**\n⏱️ Total: ${summary.totalFormatted}\n\n`;
            for (const proj of summary.projects.sort((a, b) => b.minutes - a.minutes)) {
                text += `**${proj.name}**: ${proj.durationFormatted} (${proj.entries.length} entries)\n`;
            }
            return { content: [{ type: 'text', text }] };
        }

        // INVOICE (unbilled by client)
        if (scope === 'invoice') {
            const summary = await getUnbilledByClient(auth.user.id);
            if (summary.clients.length === 0) {
                return { content: [{ type: 'text', text: `🧾 **Invoice Summary**\n\n_No unbilled time._` }] };
            }
            let text = `🧾 **Invoice Summary**\n⏱️ Total: ${summary.totalFormatted} (€${summary.totalValue})\n\n`;
            for (const client of summary.clients) {
                text += `**${client.clientName}**: ${client.durationFormatted} (€${client.valueFormatted})\n`;
                for (const proj of client.projects) {
                    text += `  • ${proj.projectName}: ${proj.durationFormatted}\n`;
                }
                text += '\n';
            }
            return { content: [{ type: 'text', text }] };
        }

        // TEAM
        if (scope === 'team') {
            const summary = await getTeamTodaySummary();
            if (summary.members.length === 0) {
                return { content: [{ type: 'text', text: `👥 **Team Today (${summary.date})**\n\n_No team activity today._` }] };
            }
            let text = `👥 **Team Today (${summary.date})**\n⏱️ Total: ${summary.teamTotalFormatted}\n\n`;
            for (const member of summary.members) {
                text += `**${member.username}**: ${member.totalFormatted}\n`;
                for (const proj of member.projects) {
                    text += `  • ${proj.name}: ${proj.durationFormatted}\n`;
                }
                text += '\n';
            }
            return { content: [{ type: 'text', text }] };
        }

        // PROJECT
        if (scope === 'project') {
            if (!project) {
                return { content: [{ type: 'text', text: '❌ project parameter is required for scope=project' }] };
            }
            const entries = await getProjectEntries(project, limit || 10);
            const projects = await getProjects();
            const projectData = projects.find(p =>
                p.id === project.toLowerCase().trim() ||
                p.name.toLowerCase() === project.toLowerCase()
            );
            if (!projectData) {
                return { content: [{ type: 'text', text: `❌ Project "${project}" not found.` }] };
            }
            let text = `📊 **${projectData.name}**\n⏱️ Total time: ${projectData.totalFormatted}\n\n`;
            if (entries.length === 0) {
                text += '_No entries yet._';
            } else {
                text += `**Recent entries:**\n`;
                for (const entry of entries) {
                    const date = new Date(entry.createdAt).toLocaleDateString();
                    text += `• \`${entry.id}\` ${date} - ${entry.durationFormatted}: ${entry.description || '(no description)'}\n`;
                }
            }
            return { content: [{ type: 'text', text }] };
        }

        return { content: [{ type: 'text', text: `❌ Unknown scope: ${scope}` }] };
    }
);

// Tool: Stopwatch for time tracking
server.tool(
    'stopwatch',
    {
        action: z.enum(['start', 'stop', 'status', 'pause', 'resume', 'cancel']).describe('Action to perform'),
        project: z.string().optional().describe('Project name (required for start)'),
        description: z.string().optional().describe('What you are working on (for start)'),
        message: z.string().optional().describe('Final summary message (for stop)'),
        billable: z.boolean().optional().describe('Whether this is billable (for stop, defaults to true)'),
        task: z.string().optional().describe('Task ID to link to (for start)')
    },
    async ({ action, project, description, message, billable, task }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        // START
        if (action === 'start') {
            if (!project) {
                return { content: [{ type: 'text', text: '❌ project is required for start action' }] };
            }
            let taskInfo = '';
            if (task) {
                const taskData = await getTask(task);
                if (taskData) {
                    taskInfo = taskData.youtrackId ? ` [${taskData.youtrackId}]` : ` [task:${task}]`;
                }
            }
            const result = await startTimer(project, (description || '') + taskInfo, auth.user.id);
            if (result.error) {
                const elapsed = formatDuration(Math.round((new Date() - new Date(result.timer.startedAt)) / 60000));
                return { content: [{ type: 'text', text: `⚠️ Timer already running on **${result.timer.projectId}** (${elapsed})\n\nStop it first.` }] };
            }
            let text = `⏱️ Timer started for **${project}**`;
            if (description) text += `\n\n${description}`;
            if (task) text += `\n📋 Linked to task${taskInfo}`;
            return { content: [{ type: 'text', text }] };
        }

        // STOP
        if (action === 'stop') {
            const result = await stopTimer(message || null, billable !== false, auth.user.id);
            if (result.error) {
                return { content: [{ type: 'text', text: '❌ No timer running.' }] };
            }
            let text = `⏹️ Timer stopped - **${result.entry.project}**\n\n${result.entry.description}`;
            text += `\n\n⏱️ ${formatDuration(result.minutes)}`;
            if (result.entry.billable === false) text += `\n🏷️ Non-billable`;
            return { content: [{ type: 'text', text }] };
        }

        // STATUS
        if (action === 'status') {
            const timer = await getActiveTimer(auth.user.id);
            if (!timer) {
                return { content: [{ type: 'text', text: '⏱️ No timer running.' }] };
            }
            let statusIcon = timer.isPaused ? '⏸️' : '⏱️';
            let statusText = timer.isPaused ? 'Paused' : 'Running';
            let text = `${statusIcon} ${statusText}: **${timer.project}** (${timer.elapsedFormatted})`;
            if (timer.description) text += `\n\n${timer.description}`;
            if (timer.totalPausedMinutes > 0) text += `\n\n⏸️ Paused time: ${formatDuration(timer.totalPausedMinutes)}`;
            return { content: [{ type: 'text', text }] };
        }

        // PAUSE
        if (action === 'pause') {
            const result = await pauseTimer(auth.user.id);
            if (result.error) {
                if (result.error === 'Timer already paused') {
                    return { content: [{ type: 'text', text: '⏸️ Timer is already paused.' }] };
                }
                return { content: [{ type: 'text', text: '❌ No timer running to pause.' }] };
            }
            return { content: [{ type: 'text', text: `⏸️ Timer paused - **${result.project}**\n\n⏱️ ${result.runningFormatted} tracked so far` }] };
        }

        // RESUME
        if (action === 'resume') {
            const result = await resumeTimer(auth.user.id);
            if (result.error) {
                if (result.error === 'Timer is not paused') {
                    return { content: [{ type: 'text', text: '▶️ Timer is already running.' }] };
                }
                return { content: [{ type: 'text', text: '❌ No timer to resume.' }] };
            }
            let text = `▶️ Timer resumed - **${result.project}**`;
            if (result.pausedMinutes > 0) text += `\n\nPaused for ${formatDuration(result.pausedMinutes)}`;
            return { content: [{ type: 'text', text }] };
        }

        // CANCEL
        if (action === 'cancel') {
            const result = await cancelTimer(auth.user.id);
            if (result.error) {
                return { content: [{ type: 'text', text: '❌ No timer to cancel.' }] };
            }
            return { content: [{ type: 'text', text: `🚫 Timer cancelled (not saved)\n\nWas tracking: **${result.project}**` }] };
        }

        return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
    }
);

// ==================== MEMORY TOOLS ====================

// Tool: Manage memories (create/delete)
server.tool(
    'memory_manage',
    {
        action: z.enum(['create', 'delete']).describe('Action to perform'),
        content: z.string().optional().describe('What to remember (for create)'),
        category: z.string().optional().describe('Category: idea, note, decision, etc. (for create)'),
        personal: z.boolean().optional().describe('Make private/not shared (for create)'),
        project: z.string().optional().describe('Link to a project (for create)'),
        client: z.string().optional().describe('Link to a client (for create)'),
        memory_id: z.string().optional().describe('ID of memory to delete (for delete)')
    },
    async ({ action, content, category, personal, project, client, memory_id }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        if (action === 'create') {
            if (!content) {
                return { content: [{ type: 'text', text: '❌ content is required for create action' }] };
            }
            try {
                await storeMemory(content, {
                    category: category || '',
                    shared: !personal,
                    project: project || null,
                    client: client || null,
                    userId: auth.user.id
                });
                let text = `🧠 Remembered${personal ? ' (personal)' : ''}${category ? ` [${category}]` : ''}`;
                if (project) text += `\n📁 Project: ${project}`;
                if (client) text += `\n👤 Client: ${client}`;
                text += `\n\n${content}`;
                return { content: [{ type: 'text', text }] };
            } catch (error) {
                return { content: [{ type: 'text', text: `❌ ${error.message}` }] };
            }
        }

        if (action === 'delete') {
            if (!memory_id) {
                return { content: [{ type: 'text', text: '❌ memory_id is required for delete action' }] };
            }
            const deleted = await deleteMemory(memory_id);
            if (!deleted) {
                return { content: [{ type: 'text', text: `❌ Memory "${memory_id}" not found.` }] };
            }
            return { content: [{ type: 'text', text: `🗑️ Forgot: ${deleted.content.substring(0, 100)}${deleted.content.length > 100 ? '...' : ''}` }] };
        }

        return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
    }
);

// Tool: Query memories and time entries
server.tool(
    'memory_query',
    {
        type: z.enum(['memories', 'ideas', 'entries']).describe('What to query'),
        query: z.string().optional().describe('Search query (semantic search)'),
        category: z.string().optional().describe('Filter by category (for memories)'),
        project: z.string().optional().describe('Filter by project'),
        client: z.string().optional().describe('Filter by client'),
        personal: z.boolean().optional().describe('Show only personal memories')
    },
    async ({ type, query, category, project, client, personal }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            // SEMANTIC SEARCH for memories
            if (type === 'memories' && query) {
                const memories = await searchMemories(query, {
                    limit: 5,
                    project: project || null,
                    client: client || null
                });
                if (memories.length === 0) {
                    return { content: [{ type: 'text', text: `🧠 No memories found for: "${query}"` }] };
                }
                let text = `🧠 **Memories matching: "${query}"**\n\n`;
                for (const memory of memories) {
                    const date = new Date(memory.createdAt).toLocaleDateString();
                    const score = memory.relevanceScore ? ` (${(memory.relevanceScore * 100).toFixed(0)}%)` : '';
                    let meta = [];
                    if (memory.category) meta.push(memory.category);
                    if (memory.projectId) meta.push(`📁 ${memory.projectId}`);
                    if (!memory.shared) meta.push('🔒');
                    text += `• ${memory.content}${meta.length ? ` [${meta.join(', ')}]` : ''} - ${date}${score}\n\n`;
                }
                return { content: [{ type: 'text', text }] };
            }

            // LIST MEMORIES
            if (type === 'memories') {
                const memories = await getAllMemories({
                    category: category || null,
                    project: project || null,
                    client: client || null,
                    personal: personal || false
                });
                if (memories.length === 0) {
                    return { content: [{ type: 'text', text: '🧠 No memories found.' }] };
                }
                let text = `🧠 **Memories** (${memories.length})\n\n`;
                for (const memory of memories.slice(-20).reverse()) {
                    const date = new Date(memory.createdAt).toLocaleDateString();
                    let meta = [];
                    if (memory.category) meta.push(memory.category);
                    if (memory.projectId) meta.push(`📁 ${memory.projectId}`);
                    if (!memory.shared) meta.push('🔒');
                    text += `• \`${memory.id}\` ${memory.content.substring(0, 80)}${memory.content.length > 80 ? '...' : ''}${meta.length ? ` [${meta.join(', ')}]` : ''} - ${date}\n`;
                }
                return { content: [{ type: 'text', text }] };
            }

            // LIST IDEAS
            if (type === 'ideas') {
                const memories = await getAllMemories({
                    category: 'idea',
                    project: project || null,
                    client: client || null
                });
                if (memories.length === 0) {
                    return { content: [{ type: 'text', text: '💡 No ideas yet.' }] };
                }
                let text = `💡 **Ideas** (${memories.length})\n\n`;
                for (const idea of memories.slice(-20).reverse()) {
                    const date = new Date(idea.createdAt).toLocaleDateString();
                    let meta = [];
                    if (idea.projectId) meta.push('📁 ' + idea.projectId);
                    text += `• \`${idea.id}\` ${idea.content.substring(0, 80)}${idea.content.length > 80 ? '...' : ''}${meta.length ? ` [${meta.join(', ')}]` : ''} - ${date}\n`;
                }
                return { content: [{ type: 'text', text }] };
            }

            // SEARCH ENTRIES
            if (type === 'entries') {
                if (!query) {
                    return { content: [{ type: 'text', text: '❌ query is required for searching entries' }] };
                }
                const entries = await searchEntries(query, 10);
                if (entries.length === 0) {
                    return { content: [{ type: 'text', text: `🔍 No entries found for: "${query}"` }] };
                }
                let text = `🔍 **Entries matching: "${query}"**\n\n`;
                for (const entry of entries) {
                    const date = new Date(entry.createdAt).toLocaleDateString();
                    const score = entry.relevanceScore ? ` (${(entry.relevanceScore * 100).toFixed(0)}%)` : '';
                    text += `• **${entry.projectName}** - ${date} - ${entry.durationFormatted}${score}\n  ${entry.description}\n\n`;
                }
                return { content: [{ type: 'text', text }] };
            }

            return { content: [{ type: 'text', text: `❌ Unknown type: ${type}` }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `❌ ${error.message}` }] };
        }
    }
);

// ==================== PROJECT & CLIENT TOOLS ====================

// Tool: Manage projects and clients (create/update)
server.tool(
    'project_manage',
    {
        entity: z.enum(['project', 'client']).describe('What to manage'),
        action: z.enum(['create', 'update']).describe('Action to perform'),
        name: z.string().describe('Project or client name'),
        client: z.string().optional().describe('Client name to link (for project)'),
        hourly_rate: z.number().optional().describe('Hourly rate for billing (for project)'),
        notes: z.string().optional().describe('Notes'),
        email: z.string().optional().describe('Email address (for client)')
    },
    async ({ entity, action, name, client, hourly_rate, notes, email }) => {
        if (entity === 'client') {
            if (action === 'create') {
                const result = await createClient(name, email || '', notes || '');
                if (result.error) {
                    return { content: [{ type: 'text', text: `⚠️ ${result.error}: ${result.client.name}` }] };
                }
                return {
                    content: [{
                        type: 'text',
                        text: `👤 Client added: **${result.name}**${email ? `\n📧 ${email}` : ''}`
                    }]
                };
            }
            if (action === 'update') {
                const updated = await updateClient(name, { email, notes });
                if (!updated) {
                    return { content: [{ type: 'text', text: `❌ Client "${name}" not found.` }] };
                }
                return { content: [{ type: 'text', text: `👤 Updated client: **${updated.name}**` }] };
            }
        }

        if (entity === 'project') {
            if (action === 'create') {
                const project = await createProject(name, client || null, hourly_rate || 0, notes || '');
                let text = `📁 Project created: **${project.name}**`;
                if (project.clientId) text += `\n👤 Client: ${project.clientId}`;
                if (project.hourlyRate) text += `\n💰 Rate: €${project.hourlyRate}/hr`;
                return { content: [{ type: 'text', text }] };
            }
            if (action === 'update') {
                const updated = await updateProject(name, { clientId: client, hourlyRate: hourly_rate, notes });
                if (!updated) {
                    return { content: [{ type: 'text', text: `❌ Project "${name}" not found.` }] };
                }
                let text = `📁 Updated project: **${updated.name}**`;
                if (updated.clientId) text += `\n👤 Client: ${updated.clientId}`;
                if (updated.hourlyRate) text += `\n💰 Rate: €${updated.hourlyRate}/hr`;
                return { content: [{ type: 'text', text }] };
            }
        }

        return { content: [{ type: 'text', text: `❌ Unknown entity/action: ${entity}/${action}` }] };
    }
);

// Tool: Query projects and clients
server.tool(
    'project_query',
    {
        entity: z.enum(['projects', 'clients']).describe('What to list'),
        client: z.string().optional().describe('Filter projects by client'),
        detailed: z.boolean().optional().describe('Show detailed info (for projects)')
    },
    async ({ entity, client, detailed }) => {
        if (entity === 'clients') {
            const clients = await getClients();
            if (clients.length === 0) {
                return { content: [{ type: 'text', text: '👥 No clients yet. Add one with project_manage.' }] };
            }
            let text = `👥 **Clients** (${clients.length})\n\n`;
            for (const c of clients) {
                text += `• **${c.name}**${c.email ? ` - ${c.email}` : ''}\n`;
            }
            return { content: [{ type: 'text', text }] };
        }

        if (entity === 'projects') {
            const projects = await getProjectsWithClients(client || null);
            if (projects.length === 0) {
                return { content: [{ type: 'text', text: `📁 No projects${client ? ` for client "${client}"` : ''}.` }] };
            }
            let text = `📁 **Projects** (${projects.length})${client ? ` [${client}]` : ''}\n\n`;
            for (const p of projects.sort((a, b) => (b.totalMinutes || 0) - (a.totalMinutes || 0))) {
                text += `• **${p.name}** - ${p.totalFormatted}`;
                if (p.clientName) text += ` (${p.clientName})`;
                if (detailed !== false && p.hourlyRate) text += ` - €${p.hourlyRate}/hr`;
                if (detailed !== false && p.estimatedValue) text += ` ≈ €${p.estimatedValue}`;
                text += '\n';
            }
            return { content: [{ type: 'text', text }] };
        }

        return { content: [{ type: 'text', text: `❌ Unknown entity: ${entity}` }] };
    }
);

// Add a prompt that instructs Claude how to use Calq interactively
server.prompt(
    'calq_guide',
    {},
    async () => ({
        messages: [{
            role: 'user',
            content: {
                type: 'text',
                text: 'You are using Calq, a time tracking and memory system. Before calling tools, briefly confirm key details with the user if not obvious. Keep it short. After actions, briefly confirm what was done.'
            }
        }]
    })
);

// ==================== USER MANAGEMENT TOOLS ====================

// Tool: Get current user info with entity counts
server.tool(
    'whoami',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: '🔒 ' + auth.error }] };
        }

        const user = auth.user;
        const counts = await getEntityCounts(user.id);

        let text = `👤 **${user.username}**\n`;
        text += `📧 ${user.email}\n`;
        text += `🏷️ Role: ${user.role}\n`;
        text += `📅 Last login: ${user.lastLogin || 'Never'}\n\n`;
        text += `**Your data:**\n`;
        text += `📁 ${counts.projects} projects | 👥 ${counts.clients} clients\n`;
        text += `⏱️ ${counts.entries} entries | 📋 ${counts.tasks} tasks | 🧠 ${counts.memories} memories`;

        return { content: [{ type: 'text', text }] };
    }
);

// Tool: User management (list users, set roles - admin only)
server.tool(
    'user_manage',
    {
        action: z.enum(['list', 'set_role']).describe('Action to perform'),
        username: z.string().optional().describe('Username (for set_role)'),
        role: z.enum(['admin', 'member']).optional().describe('New role (for set_role)')
    },
    async ({ action, username, role }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: '🔒 ' + auth.error }] };
        }

        if (auth.user.role !== 'admin') {
            return { content: [{ type: 'text', text: '🔒 Admin access required' }] };
        }

        if (action === 'list') {
            const users = await getUsers();
            if (users.length === 0) {
                return { content: [{ type: 'text', text: '👥 No users yet. Complete OAuth authentication first.' }] };
            }
            let text = `👥 **Users** (${users.length})\n\n`;
            for (const user of users) {
                const roleIcon = user.role === 'admin' ? '👑' : '👤';
                const lastLogin = user.lastLogin ? ` (last: ${new Date(user.lastLogin).toLocaleDateString()})` : '';
                text += `${roleIcon} **${user.username}** - ${user.email}${lastLogin}\n`;
            }
            return { content: [{ type: 'text', text }] };
        }

        if (action === 'set_role') {
            if (!username) {
                return { content: [{ type: 'text', text: '❌ username is required for set_role action' }] };
            }
            if (!role) {
                return { content: [{ type: 'text', text: '❌ role is required for set_role action' }] };
            }
            const updated = await updateUserAuth(username, { role });
            if (!updated) {
                return { content: [{ type: 'text', text: `❌ User "${username}" not found` }] };
            }
            const roleIcon = role === 'admin' ? '👑 admin' : '👤 member';
            return { content: [{ type: 'text', text: `✅ ${updated.username} is now ${roleIcon}` }] };
        }

        return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
    }
);

// ==================== TASK TOOLS ====================

// Tool: Task management (list/create/complete)
server.tool(
    'task_manage',
    {
        action: z.enum(['list', 'create', 'complete']).describe('Action to perform'),
        // For list
        status: z.enum(['open', 'done', 'all']).optional().describe('Filter by status (for list, default: open)'),
        project: z.string().optional().describe('Filter by or link to project'),
        mine: z.boolean().optional().describe('Show only my tasks (for list)'),
        // For create
        title: z.string().optional().describe('Task title (for create)'),
        issue: z.string().optional().describe('YouTrack issue ID e.g. "PROJ-123" (for create)'),
        // For complete
        id: z.string().optional().describe('Task ID (for complete)'),
        log_time: z.number().optional().describe('Minutes to log when completing')
    },
    async ({ action, status, project, mine, title, issue, id, log_time }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        // LIST
        if (action === 'list') {
            const taskList = await getTasks({
                status: status || 'open',
                project: project || null,
                mine: mine || false
            });
            if (taskList.length === 0) {
                const statusText = status === 'all' ? '' : (status || 'open');
                return { content: [{ type: 'text', text: `📋 No ${statusText} tasks${project ? ` for ${project}` : ''}.` }] };
            }
            let text = `📋 **Tasks** (${taskList.length})\n\n`;
            for (const task of taskList) {
                const statusIcon = task.status === 'done' ? '✅' : '⬜';
                const ytLink = task.youtrackId ? ` [${task.youtrackId}]` : '';
                const projectTag = task.projectName ? ` 📁 ${task.projectName}` : '';
                text += `${statusIcon} \`${task.id}\` ${task.title}${ytLink}${projectTag}\n`;
            }
            return { content: [{ type: 'text', text }] };
        }

        // CREATE
        if (action === 'create') {
            if (!title) {
                return { content: [{ type: 'text', text: '❌ title is required for create action' }] };
            }
            const task = await createTask(title, project || null, issue || null, auth.user.id);
            let text = `📋 Task added: **${task.title}**`;
            if (task.projectId) text += `\n📁 Project: ${task.projectId}`;
            if (task.youtrackId) text += `\n🔗 YouTrack: ${task.youtrackId}`;
            return { content: [{ type: 'text', text }] };
        }

        // COMPLETE
        if (action === 'complete') {
            if (!id) {
                return { content: [{ type: 'text', text: '❌ id is required for complete action' }] };
            }
            const task = await getTask(id);
            if (!task) {
                return { content: [{ type: 'text', text: `❌ Task "${id}" not found.` }] };
            }
            const result = await completeTask(id, auth.user.id);
            if (result.error) {
                return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
            }
            let text = `✅ Completed: **${task.title}**`;

            // If task is linked to YouTrack, sync the status
            if (task.youtrackId) {
                try {
                    const token = await getUserYouTrackToken(auth.user.id);
                    if (token) {
                        const yt = getYouTrackClient(token);
                        if (log_time && log_time > 0) {
                            await yt.addWorkItem(task.youtrackId, log_time, `Completed: ${task.title}`);
                            text += `\n⏱️ Logged ${formatDuration(log_time)} to YouTrack`;
                        }
                        await yt.resolveIssue(task.youtrackId);
                        text += `\n🔗 YouTrack ${task.youtrackId} resolved`;
                    } else {
                        text += `\n⚠️ YouTrack not synced (no token). Use youtrack action=connect to link.`;
                    }
                } catch (error) {
                    text += `\n⚠️ YouTrack sync failed: ${error.message}`;
                }
            }
            return { content: [{ type: 'text', text }] };
        }

        return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
    }
);

// ==================== YOUTRACK TOOLS ====================

// Tool: YouTrack integration (connect/list/get/comment/resolve)
server.tool(
    'youtrack',
    {
        action: z.enum(['connect', 'list', 'get', 'comment', 'resolve']).describe('Action to perform'),
        // For connect
        token: z.string().optional().describe('YouTrack API token (for connect)'),
        // For list
        query: z.string().optional().describe('YouTrack search query (for list)'),
        project: z.string().optional().describe('Filter by YouTrack project (for list)'),
        assignee: z.enum(['me', 'all']).optional().describe('Filter by assignee (for list, default: me)'),
        // For get/comment/resolve
        id: z.string().optional().describe('Issue ID e.g. "PROJ-123" (for get/comment/resolve)'),
        comment: z.string().optional().describe('Comment text (for comment action)')
    },
    async ({ action, token, query, project, assignee, id, comment }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        // CONNECT
        if (action === 'connect') {
            if (!token) {
                return { content: [{ type: 'text', text: '❌ token is required for connect action' }] };
            }
            try {
                const yt = getYouTrackClient(token);
                await yt.getIssues('', null, 'me');
                await setUserYouTrackToken(auth.user.id, token);
                return { content: [{ type: 'text', text: `🔗 YouTrack connected! Use action=list to fetch issues.` }] };
            } catch (error) {
                return { content: [{ type: 'text', text: `❌ Failed to connect: ${error.message}` }] };
            }
        }

        // Check token for other actions
        const userToken = await getUserYouTrackToken(auth.user.id);
        if (!userToken) {
            return { content: [{ type: 'text', text: `🔗 YouTrack not connected. Use action=connect with your API token first.` }] };
        }

        try {
            const yt = getYouTrackClient(userToken);

            // LIST
            if (action === 'list') {
                const issues = await yt.getIssues(query || '', project || null, assignee || 'me');
                if (issues.length === 0) {
                    return { content: [{ type: 'text', text: `📋 No issues found${project ? ` in ${project}` : ''}.` }] };
                }
                let syncedCount = 0;
                for (const issue of issues) {
                    const status = issue.resolved ? 'done' : 'open';
                    const localProject = issue.project ? issue.project.toLowerCase() : null;
                    await upsertTaskFromYouTrack(issue.id, issue.summary, issue.description || '', status, localProject, auth.user.id);
                    syncedCount++;
                }
                let text = `📋 **YouTrack Issues** (${issues.length})\n\n`;
                for (const issue of issues) {
                    const statusIcon = issue.resolved ? '✅' : '⬜';
                    text += `${statusIcon} **${issue.id}** - ${issue.summary}\n`;
                    if (issue.project) text += `   📁 ${issue.project}\n`;
                }
                text += `\n🔄 Synced ${syncedCount} issues to local tasks.`;
                return { content: [{ type: 'text', text }] };
            }

            // GET
            if (action === 'get') {
                if (!id) {
                    return { content: [{ type: 'text', text: '❌ id is required for get action' }] };
                }
                const issue = await yt.getIssue(id);
                let text = `📋 **${issue.id}** - ${issue.summary}\n\n`;
                text += `🏷️ State: ${issue.state}\n`;
                text += `📁 Project: ${issue.projectName || issue.project}\n`;
                if (issue.description) {
                    text += `\n${issue.description.substring(0, 500)}${issue.description.length > 500 ? '...' : ''}`;
                }
                return { content: [{ type: 'text', text }] };
            }

            // COMMENT
            if (action === 'comment') {
                if (!id) {
                    return { content: [{ type: 'text', text: '❌ id is required for comment action' }] };
                }
                if (!comment) {
                    return { content: [{ type: 'text', text: '❌ comment is required for comment action' }] };
                }
                await yt.addComment(id, comment);
                return { content: [{ type: 'text', text: `💬 Comment added to ${id}` }] };
            }

            // RESOLVE
            if (action === 'resolve') {
                if (!id) {
                    return { content: [{ type: 'text', text: '❌ id is required for resolve action' }] };
                }
                await yt.resolveIssue(id);
                const issue = await yt.getIssue(id);
                await upsertTaskFromYouTrack(id, issue.summary, issue.description || '', 'done', null, auth.user.id);
                return { content: [{ type: 'text', text: `✅ Resolved ${id}` }] };
            }

            return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `❌ YouTrack error: ${error.message}` }] };
        }
    }
);

// ==================== OBSERVATION TOOLS ====================

// Tool: Observation system (observe/summarize/get_context/search)
server.tool(
    'observation',
    {
        action: z.enum(['observe', 'summarize', 'get_context', 'search']).describe('Action to perform'),
        // Common
        project: z.string().optional().describe('Project name or path'),
        session_id: z.string().optional().describe('Claude session ID (for observe/summarize)'),
        // For observe
        type: z.enum(['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change']).optional().describe('Type of observation'),
        title: z.string().optional().describe('Short title (for observe)'),
        subtitle: z.string().optional().describe('One sentence explanation'),
        narrative: z.string().optional().describe('Full context explanation'),
        facts: z.array(z.string()).optional().describe('Array of fact statements'),
        concepts: z.array(z.enum(['how-it-works', 'why-it-exists', 'problem-solution', 'gotcha', 'pattern', 'trade-off'])).optional().describe('Concept tags'),
        files_read: z.array(z.string()).optional().describe('Files that were read'),
        files_modified: z.array(z.string()).optional().describe('Files that were modified'),
        tool_name: z.string().optional().describe('Tool that triggered observation'),
        tool_input: z.string().optional().describe('Tool input (sanitized)'),
        // For summarize
        request: z.string().optional().describe('What user asked for (for summarize)'),
        investigated: z.string().optional().describe('What was looked into'),
        learned: z.string().optional().describe('Key insights discovered'),
        completed: z.string().optional().describe('What was delivered'),
        next_steps: z.string().optional().describe('Recommended follow-ups'),
        notes: z.string().optional().describe('Additional context'),
        files_edited: z.array(z.string()).optional().describe('Files that were edited'),
        // For get_context/search
        query: z.string().optional().describe('Search query (for search)'),
        limit: z.number().optional().describe('Max results'),
        include_summaries: z.boolean().optional().describe('Include summaries (for get_context)')
    },
    async (params) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const { action, project, session_id, type, title, subtitle, narrative, facts, concepts,
            files_read, files_modified, tool_name, tool_input, request, investigated, learned,
            completed, next_steps, notes, files_edited, query, limit, include_summaries } = params;

        const typeIcons = {
            bugfix: '🐛', feature: '✨', refactor: '♻️',
            discovery: '🔍', decision: '🎯', change: '📝'
        };

        try {
            // OBSERVE
            if (action === 'observe') {
                if (!session_id || !project || !type || !title) {
                    return { content: [{ type: 'text', text: '❌ session_id, project, type, and title are required for observe' }] };
                }
                await createObservation({
                    sessionId: session_id, userId: auth.user.id, project, type, title, subtitle,
                    narrative, facts, concepts, filesRead: files_read, filesModified: files_modified,
                    toolName: tool_name, toolInput: tool_input
                });
                return { content: [{ type: 'text', text: `📝 Observation stored: ${title}` }] };
            }

            // SUMMARIZE
            if (action === 'summarize') {
                if (!session_id || !project || !request) {
                    return { content: [{ type: 'text', text: '❌ session_id, project, and request are required for summarize' }] };
                }
                await createSessionSummary({
                    sessionId: session_id, userId: auth.user.id, project, request,
                    investigated, learned, completed, nextSteps: next_steps, notes,
                    filesRead: files_read, filesEdited: files_edited
                });
                return { content: [{ type: 'text', text: `📋 Session summary saved for: ${request.slice(0, 50)}...` }] };
            }

            // GET_CONTEXT
            if (action === 'get_context') {
                if (!project) {
                    return { content: [{ type: 'text', text: '❌ project is required for get_context' }] };
                }
                const maxObs = limit || 20;
                const obs = await getObservations({ project, userId: auth.user.id, limit: maxObs });
                const summaries = include_summaries !== false ? await getSessionSummaries({
                    project, userId: auth.user.id, limit: 5
                }) : [];

                if (obs.length === 0 && summaries.length === 0) {
                    return { content: [{ type: 'text', text: `📭 No context found for project: ${project}` }] };
                }

                let text = `# Context for ${project}\n\n`;
                if (summaries.length > 0) {
                    text += `## Recent Sessions\n\n`;
                    for (const s of summaries) {
                        text += `### ${s.request}\n`;
                        if (s.completed) text += `**Completed:** ${s.completed}\n`;
                        if (s.learned) text += `**Learned:** ${s.learned}\n`;
                        if (s.nextSteps) text += `**Next:** ${s.nextSteps}\n`;
                        text += '\n';
                    }
                }
                if (obs.length > 0) {
                    text += `## Observations (${obs.length})\n\n`;
                    for (const o of obs) {
                        const icon = typeIcons[o.type] || '📌';
                        text += `${icon} **${o.title}**`;
                        if (o.subtitle) text += ` - ${o.subtitle}`;
                        text += '\n';
                        if (o.facts && o.facts.length > 0) {
                            for (const fact of o.facts.slice(0, 3)) {
                                text += `  • ${fact}\n`;
                            }
                        }
                    }
                }
                return { content: [{ type: 'text', text }] };
            }

            // SEARCH
            if (action === 'search') {
                if (!query) {
                    return { content: [{ type: 'text', text: '❌ query is required for search' }] };
                }
                const results = await searchObservations(query, {
                    project, type, userId: auth.user.id, limit: limit || 10
                });
                if (results.length === 0) {
                    return { content: [{ type: 'text', text: `🔍 No observations found for: "${query}"` }] };
                }
                let text = `🔍 **Search Results** (${results.length})\n\n`;
                for (const o of results) {
                    const icon = typeIcons[o.type] || '📌';
                    text += `${icon} **${o.title}**`;
                    if (o.project) text += ` (${o.project})`;
                    text += '\n';
                    if (o.subtitle) text += `   ${o.subtitle}\n`;
                    if (o.narrative) text += `   ${o.narrative.slice(0, 150)}...\n`;
                    text += '\n';
                }
                return { content: [{ type: 'text', text }] };
            }

            return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `❌ ${error.message}` }] };
        }
    }
);

// ==================== CALQ CONFIGURATION SYSTEM ====================

// Current version of Calq configuration files
const CALQ_CONFIG_VERSION = '1.0.0';

// Generate all Calq configuration files
function generateCalqConfig(baseUrl) {
    const config = {
        version: CALQ_CONFIG_VERSION,
        files: {}
    };

    // Version manifest file
    config.files['.claude/calq/manifest.json'] = JSON.stringify({
        version: CALQ_CONFIG_VERSION,
        installedAt: new Date().toISOString(),
        baseUrl
    }, null, 2);

    // Hooks configuration
    config.files['.claude/hooks/calq.json'] = JSON.stringify({
        hooks: {
            PostToolUse: [{
                type: "command",
                command: `node .claude/calq/hooks/observe.js "$TOOL_NAME" "$TOOL_INPUT" "$TOOL_OUTPUT" "$SESSION_ID" "$CWD"`,
                description: "Send tool observations to Calq"
            }],
            Stop: [{
                type: "command",
                command: `node .claude/calq/hooks/summary.js "$SESSION_ID" "$CWD" "$TRANSCRIPT_PATH"`,
                description: "Generate session summary in Calq"
            }],
            SessionStart: [{
                type: "command",
                command: `node .claude/calq/hooks/context.js "$SESSION_ID" "$CWD"`,
                description: "Inject Calq context into session"
            }]
        }
    }, null, 2);

    // PostToolUse hook script
    config.files['.claude/calq/hooks/observe.js'] = `#!/usr/bin/env node
// Calq observation hook v${CALQ_CONFIG_VERSION}
const [,, toolName, toolInput, toolOutput, sessionId, cwd] = process.argv;

const CALQ_URL = process.env.CALQ_MCP_URL || '${baseUrl}/mcp';
const CALQ_TOKEN = process.env.CALQ_TOKEN;

if (!CALQ_TOKEN) process.exit(0);

// Skip tools that don't need observation
const skipTools = ['TodoRead', 'TodoWrite', 'AskFollowupQuestion', 'Task'];
if (skipTools.includes(toolName)) process.exit(0);

// Fire and forget
fetch(CALQ_URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${CALQ_TOKEN}\`
    },
    body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
            name: 'observe',
            arguments: {
                session_id: sessionId,
                project: cwd.split('/').pop(),
                type: 'change',
                title: \`\${toolName} execution\`,
                tool_name: toolName,
                tool_input: toolInput?.slice(0, 1000)
            }
        },
        id: Date.now()
    })
}).catch(() => {});
`;

    // Stop hook script
    config.files['.claude/calq/hooks/summary.js'] = `#!/usr/bin/env node
// Calq session summary hook v${CALQ_CONFIG_VERSION}
const [,, sessionId, cwd, transcriptPath] = process.argv;
const fs = require('fs');

const CALQ_URL = process.env.CALQ_MCP_URL || '${baseUrl}/mcp';
const CALQ_TOKEN = process.env.CALQ_TOKEN;

if (!CALQ_TOKEN) process.exit(0);

let request = 'Session completed';
try {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
        const transcript = fs.readFileSync(transcriptPath, 'utf8');
        const match = transcript.match(/user:\\s*(.+?)(?=\\n|$)/i);
        if (match) request = match[1].slice(0, 200);
    }
} catch (e) {}

fetch(CALQ_URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${CALQ_TOKEN}\`
    },
    body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
            name: 'summarize_session',
            arguments: { session_id: sessionId, project: cwd.split('/').pop(), request }
        },
        id: Date.now()
    })
}).catch(() => {});
`;

    // SessionStart hook
    config.files['.claude/calq/hooks/context.js'] = `#!/usr/bin/env node
// Calq context injection hook v${CALQ_CONFIG_VERSION}
const [,, sessionId, cwd] = process.argv;

const CALQ_URL = process.env.CALQ_MCP_URL || '${baseUrl}/mcp';
const CALQ_TOKEN = process.env.CALQ_TOKEN;

if (!CALQ_TOKEN) process.exit(0);

const project = cwd.split('/').pop();

fetch(CALQ_URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${CALQ_TOKEN}\`
    },
    body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
            name: 'get_context',
            arguments: { project, limit: 15 }
        },
        id: Date.now()
    })
})
.then(r => r.json())
.then(data => {
    if (data.result?.content?.[0]?.text) {
        console.log('<calq-context>');
        console.log(data.result.content[0].text);
        console.log('</calq-context>');
    }
})
.catch(() => {});
`;

    // Slash commands
    config.files['.claude/commands/calq-status.md'] = `---
description: Show your Calq time tracking status
---

Use the Calq MCP to show my current timer status and today's time summary. Call the \`timer\` and \`today\` tools.`;

    config.files['.claude/commands/calq-log.md'] = `---
description: Log time to a project
---

Log time to a project using Calq. Ask me which project and how much time, then use the \`commit\` tool to log it.

Example: "Log 2 hours to project-name for implementing feature X"`;

    config.files['.claude/commands/calq-tasks.md'] = `---
description: Show your tasks
---

Show my current tasks from Calq. Use the \`tasks\` tool to list them.`;

    config.files['.claude/commands/calq-update.md'] = `---
description: Check for Calq configuration updates
---

Check if the Calq configuration in this project is up to date by calling the \`calq_check_update\` tool. If updates are available, use the \`install\` tool to update.`;

    // Skills
    config.files['.claude/skills/calq-remember.md'] = `---
description: Remember something for later using Calq
---

When the user wants to remember something:
1. Use the Calq MCP \`remember\` tool to store the memory
2. Optionally categorize it (decision, learning, note, todo)
3. Confirm what was saved`;

    config.files['.claude/skills/calq-time.md'] = `---
description: Track time with Calq
---

When the user wants to track time:
1. For starting work: Use \`start\` tool to begin a timer
2. For stopping: Use \`stop\` tool to stop and log the time
3. For manual logging: Use \`commit\` tool with duration and description
4. For status: Use \`timer\` tool to see current timer, \`today\` for daily summary`;

    // Agents
    config.files['.claude/agents/calq-reviewer.md'] = `---
description: Code reviewer that logs observations to Calq
model: haiku
tools: [Read, Grep, Glob, mcp__calq__observe]
---

You are a code review agent. When reviewing code:
1. Look for bugs, security issues, and code quality problems
2. For each significant finding, use the \`observe\` tool to log it with type "discovery"
3. Summarize your findings at the end

Focus on actionable feedback. Don't log trivial observations.`;

    config.files['.claude/agents/calq-learner.md'] = `---
description: Extracts and stores learnings from conversations
model: haiku
tools: [mcp__calq__observe, mcp__calq__summarize_session]
---

You are a learning extraction agent. Review the conversation and:
1. Identify key decisions made (type: decision)
2. Note any bugs found and fixed (type: bugfix)
3. Document new features implemented (type: feature)
4. Capture important discoveries about the codebase (type: discovery)

Use the \`observe\` tool for each learning. Be concise but capture the essential context.`;

    // Output styles
    config.files['.claude/output-styles/calq-commit-style.md'] = `---
description: Concise commit-style output for time tracking
---

Format your responses as structured summaries:
- Start with a clear one-line title of what was done
- List key changes as bullet points
- Include time estimate if relevant
- End with any follow-up recommendations

Keep responses concise and actionable. Avoid unnecessary explanation.`;

    config.files['.claude/output-styles/calq-learning.md'] = `---
description: Learning-focused output that captures insights
---

When completing tasks, structure your response to highlight learnings:
1. **What was done**: Brief summary of the work
2. **What was learned**: Key insights or discoveries about the codebase
3. **Key patterns**: Any patterns, conventions, or architectural decisions observed
4. **Gotchas**: Anything surprising or counter-intuitive encountered

This helps build team knowledge over time.`;

    // Rules (modular rules in .claude/rules/ directory)
    config.files['.claude/rules/no-title-case.md'] = `---
description: Avoid title case in headings and titles
---

# No title case

When writing titles, headings, or labels, use sentence case instead of title case.

**Do this:** "This is a title"
**Not this:** "This Is A Title"

This applies to:
- Markdown headings
- UI labels and buttons
- Documentation titles
- Commit message subjects
- PR titles`;

    return config;
}

// Tool: Install or update Calq configuration
server.tool(
    'install',
    {
        components: z.array(z.enum(['hooks', 'commands', 'skills', 'agents', 'output-styles', 'rules', 'all'])).optional()
            .describe('Components to install (default: all)'),
        force: z.boolean().optional().describe('Force reinstall even if up to date'),
        include_community: z.boolean().optional().describe('Include team-contributed components (default: true)')
    },
    async ({ components, force, include_community }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const baseUrl = process.env.BASE_URL || 'https://mcp.calq.nl';
        const config = generateCalqConfig(baseUrl);

        // Filter files based on components
        const includeAll = !components || components.includes('all');
        const includeHooks = includeAll || components.includes('hooks');
        const includeCommands = includeAll || components.includes('commands');
        const includeSkills = includeAll || components.includes('skills');
        const includeAgents = includeAll || components.includes('agents');
        const includeOutputStyles = includeAll || components.includes('output-styles');
        const includeRules = includeAll || components.includes('rules');
        const includeCommunity = include_community !== false;

        const filteredFiles = {};
        for (const [path, content] of Object.entries(config.files)) {
            if (path.includes('manifest')) {
                filteredFiles[path] = content;
            } else if (path.includes('/hooks/') && includeHooks) {
                filteredFiles[path] = content;
            } else if (path.includes('/commands/') && includeCommands) {
                filteredFiles[path] = content;
            } else if (path.includes('/skills/') && includeSkills) {
                filteredFiles[path] = content;
            } else if (path.includes('/agents/') && includeAgents) {
                filteredFiles[path] = content;
            } else if (path.includes('/output-styles/') && includeOutputStyles) {
                filteredFiles[path] = content;
            } else if (path.includes('/rules/') && includeRules) {
                filteredFiles[path] = content;
            }
        }

        // Add community components from database (overrides builtins with same name)
        if (includeCommunity) {
            const communityComponents = await getComponents({ includeBuiltin: false });
            for (const comp of communityComponents) {
                // Map component type to directory
                const dirMap = {
                    'agent': 'agents',
                    'skill': 'skills',
                    'command': 'commands',
                    'output-style': 'output-styles',
                    'hook': 'calq/hooks',
                    'rule': 'rules'
                };
                const dir = dirMap[comp.type];
                if (!dir) continue;

                // Check if this type should be included
                const shouldInclude = (
                    (comp.type === 'agent' && includeAgents) ||
                    (comp.type === 'skill' && includeSkills) ||
                    (comp.type === 'command' && includeCommands) ||
                    (comp.type === 'output-style' && includeOutputStyles) ||
                    (comp.type === 'hook' && includeHooks) ||
                    (comp.type === 'rule' && includeRules)
                );

                if (shouldInclude) {
                    const ext = comp.type === 'hook' ? 'js' : 'md';
                    const filePath = `.claude/${dir}/${comp.name}.${ext}`;
                    // Community components override builtins - mark if replacing
                    const isOverride = filteredFiles[filePath] !== undefined;
                    filteredFiles[filePath] = comp.content;
                    if (isOverride) {
                        // Add a comment to indicate this is a community override
                        if (ext === 'md' && !comp.content.includes('# Community override')) {
                            filteredFiles[filePath] = comp.content.replace(
                                /^(---\n)/,
                                `$1# Community override of builtin by ${comp.authorId || 'team'}\n`
                            );
                        }
                    }
                }
            }
        }

        // Format output
        let text = `# Calq Configuration v${CALQ_CONFIG_VERSION}\n\n`;
        text += `Create or update the following files in your project:\n\n`;

        for (const [path, content] of Object.entries(filteredFiles)) {
            const ext = path.split('.').pop();
            const lang = ext === 'json' ? 'json' : ext === 'js' ? 'javascript' : 'markdown';
            text += `## \`${path}\`\n\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
        }

        text += `## Setup\n\n`;
        text += `1. Create the files above (Claude can do this for you)\n`;
        text += `2. Set environment variable: \`export CALQ_TOKEN=your_token\`\n`;
        text += `3. Hooks will automatically capture observations and inject context\n\n`;
        text += `Use \`/calq-update\` periodically to check for configuration updates.`;

        return { content: [{ type: 'text', text }] };
    }
);

// Tool: Manage Calq components (CRUD + list + check_update)
server.tool(
    'component_manage',
    {
        action: z.enum(['create', 'read', 'update', 'delete', 'list', 'check_update']).describe('Action to perform'),
        // For CRUD operations
        type: z.enum(['agent', 'skill', 'command', 'output-style', 'hook', 'rule']).optional()
            .describe('Component type (required for create/read/update/delete, optional filter for list)'),
        name: z.string().optional().describe('Component name (required for create/read/update/delete)'),
        description: z.string().optional().describe('Brief description (required for create/update)'),
        content: z.string().optional().describe('Full markdown content. TIP: Use Claude Code docs for format. Required for create/update.'),
        version: z.string().optional().describe('Version string (default: 1.0.0)'),
        // For check_update
        current_version: z.string().optional().describe('Current installed version from manifest.json (for check_update)')
    },
    async ({ action, type, name, description, content, version, current_version }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const baseUrl = process.env.BASE_URL || 'https://mcp.calq.nl';

        try {
            // CHECK_UPDATE
            if (action === 'check_update') {
                if (!current_version) {
                    return { content: [{ type: 'text', text: `📦 **Calq not installed**\n\nNo manifest found. Use the \`install\` tool to set up Calq.` }] };
                }
                const isOutdated = current_version !== CALQ_CONFIG_VERSION;
                if (isOutdated) {
                    return { content: [{ type: 'text', text: `🔄 **Update available**\n\nInstalled: v${current_version}\nLatest: v${CALQ_CONFIG_VERSION}\n\nUse \`install\` to update.` }] };
                }
                return { content: [{ type: 'text', text: `✅ **Calq is up to date**\n\nVersion: v${CALQ_CONFIG_VERSION}` }] };
            }

            // LIST
            if (action === 'list') {
                const config = generateCalqConfig(baseUrl);
                const builtinComponents = { hooks: [], commands: [], skills: [], agents: [], 'output-styles': [], rules: [] };

                for (const path of Object.keys(config.files)) {
                    const filename = path.split('/').pop();
                    if (path.includes('/hooks/') && filename.endsWith('.js')) {
                        builtinComponents.hooks.push({ name: filename.replace('.js', ''), builtin: true });
                    } else if (path.includes('/commands/')) {
                        builtinComponents.commands.push({ name: filename.replace('.md', ''), builtin: true });
                    } else if (path.includes('/skills/')) {
                        builtinComponents.skills.push({ name: filename.replace('.md', ''), builtin: true });
                    } else if (path.includes('/agents/')) {
                        builtinComponents.agents.push({ name: filename.replace('.md', ''), builtin: true });
                    } else if (path.includes('/output-styles/')) {
                        builtinComponents['output-styles'].push({ name: filename.replace('.md', ''), builtin: true });
                    } else if (path.includes('/rules/')) {
                        builtinComponents.rules.push({ name: filename.replace('.md', ''), builtin: true });
                    }
                }

                const dbComponents = await getComponents();
                const typeMap = { 'agent': 'agents', 'skill': 'skills', 'command': 'commands', 'output-style': 'output-styles', 'hook': 'hooks', 'rule': 'rules' };

                for (const comp of dbComponents) {
                    const listType = typeMap[comp.type];
                    if (!listType || !builtinComponents[listType]) continue;
                    const builtinMatch = builtinComponents[listType].find(b => b.name === comp.name && b.builtin);
                    if (builtinMatch) {
                        builtinMatch.overriddenBy = comp.authorId || 'team';
                        builtinMatch.overrideDescription = comp.description;
                    } else {
                        builtinComponents[listType].push({ name: comp.name, builtin: false, author: comp.authorId, description: comp.description });
                    }
                }

                let text = `# Calq Components v${CALQ_CONFIG_VERSION}\n\n`;
                const typeFilter = type ? typeMap[type] || type : null;
                const types = typeFilter ? [typeFilter] : ['hooks', 'commands', 'skills', 'agents', 'output-styles', 'rules'];

                for (const t of types) {
                    const items = builtinComponents[t] || [];
                    if (items.length === 0) continue;
                    text += `## ${t.charAt(0).toUpperCase() + t.slice(1)}\n`;
                    for (const item of items) {
                        const prefix = t === 'commands' ? '/' : '';
                        if (item.builtin && item.overriddenBy) {
                            text += `- ${prefix}${item.name} *(overridden by ${item.overriddenBy})*\n`;
                        } else if (item.builtin) {
                            text += `- ${prefix}${item.name}\n`;
                        } else {
                            text += `- ${prefix}${item.name} *(by ${item.author || 'team'})*\n`;
                        }
                    }
                    text += '\n';
                }
                text += `---\nUse \`install\` to install, \`component_manage\` for CRUD.`;
                return { content: [{ type: 'text', text }] };
            }

            // READ
            if (action === 'read') {
                if (!type || !name) {
                    return { content: [{ type: 'text', text: '❌ type and name are required for read' }] };
                }
                const comp = await getComponent(type, name);
                if (!comp) {
                    return { content: [{ type: 'text', text: `❌ Component not found: ${type}/${name}` }] };
                }
                return {
                    content: [{
                        type: 'text',
                        text: `# ${type}/${comp.name}\n\n**Version:** ${comp.version}\n**Author:** ${comp.authorId || 'builtin'}\n**Description:** ${comp.description || 'No description'}\n\n## Content\n\n\`\`\`markdown\n${comp.content}\n\`\`\``
                    }]
                };
            }

            // DELETE
            if (action === 'delete') {
                if (!type || !name) {
                    return { content: [{ type: 'text', text: '❌ type and name are required for delete' }] };
                }
                const deleted = await deleteComponent(type, name);
                if (!deleted) {
                    return { content: [{ type: 'text', text: `❌ Component not found: ${type}/${name}` }] };
                }
                return { content: [{ type: 'text', text: `🗑️ Deleted: ${type}/${deleted.name}` }] };
            }

            // CREATE / UPDATE
            if (action === 'create' || action === 'update') {
                if (!type || !name) {
                    return { content: [{ type: 'text', text: `❌ type and name are required for ${action}` }] };
                }
                if (!content) {
                    return { content: [{ type: 'text', text: `❌ content is required for ${action}` }] };
                }
                if (!description) {
                    return { content: [{ type: 'text', text: `❌ description is required for ${action}` }] };
                }

                const result = await publishComponent({
                    type, name, description, content,
                    authorId: auth.user.id,
                    version: version || '1.0.0'
                });

                const actionWord = result.isNew ? 'Created' : 'Updated';
                return {
                    content: [{
                        type: 'text',
                        text: `✅ **${actionWord}:** ${type}/${result.name}\n\nVersion: ${result.version}\nDescription: ${description}\n\nTeam members can now install this with \`install\`.`
                    }]
                };
            }

            return { content: [{ type: 'text', text: `❌ Unknown action: ${action}` }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `❌ Failed: ${error.message}` }] };
        }
    }
);

// Graceful shutdown
function setupGracefulShutdown(httpServer) {
    const shutdown = (signal) => {
        console.log(`\n${signal} received, shutting down gracefully...`);
        httpServer.close(() => {
            console.log('HTTP server closed');
            process.exit(0);
        });
        // Force exit after 10 seconds
        setTimeout(() => {
            console.log('Forcing shutdown');
            process.exit(1);
        }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start the server
async function main() {
    const port = parseInt(process.env.MCP_PORT || '3000');
    const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

    const app = express();
    app.set('trust proxy', 1); // Trust first proxy (nginx)
    app.use(express.json());

    // Store sessions
    const sessions = new Map();

    // Setup MCP OAuth using the SDK's auth router
    const authRouter = mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(baseUrl),
        baseUrl: new URL(baseUrl),
        scopesSupported: ['mcp:tools'],
        resourceName: 'Calq MCP Server'
    });
    app.use(authRouter);

    // GitHub OAuth callback - handles the redirect from GitHub
    app.get('/oauth/github/callback', async (req, res) => {
        const { code, state } = req.query;

        if (!code || !state) {
            res.status(400).send('Missing code or state');
            return;
        }

        try {
            const redirectUrl = await oauthProvider.handleGitHubCallback(code, state);
            res.redirect(redirectUrl);
        } catch (error) {
            res.status(500).send(`GitHub authentication failed: ${error.message}`);
        }
    });

    // Bearer auth middleware for protected endpoints
    const bearerAuthMiddleware = requireBearerAuth({
        verifier: {
            verifyAccessToken: async (token) => {
                try {
                    const result = await oauthProvider.verifyAccessToken(token);
                    console.log('Token verified for user:', result.userId);
                    return result;
                } catch (error) {
                    console.error('Token verification failed:', error.message);
                    throw error;
                }
            }
        }
    });

    // Wrap to catch errors from the middleware itself
    const bearerAuth = (req, res, next) => {
        Promise.resolve(bearerAuthMiddleware(req, res, next)).catch(err => {
            console.error('Bearer auth middleware error:', err);
            next(err);
        });
    };

    // MCP endpoint handler (shared for GET, POST, DELETE)
    async function handleMcpRequest(req, res) {
        const sessionId = req.headers['mcp-session-id'];

        // Get user from auth context (set by bearerAuth middleware)
        const authInfo = req.auth;
        let user = null;
        if (authInfo && authInfo.userId) {
            user = await getUser(authInfo.userId);
        }

        let transport;
        let newSessionId;

        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            transport = session.transport;
            // Update user if we have auth info
            if (user) {
                session.user = user;
            } else {
                user = session.user;
            }
        } else {
            // Create new session
            newSessionId = crypto.randomUUID();
            transport = new StreamableHTTPServerTransport({
                sessionId: newSessionId
            });

            sessions.set(newSessionId, { transport, user });
            await server.connect(transport);
        }

        // Run request with user context
        await requestContext.run({ user }, async () => {
            try {
                if (newSessionId) {
                    res.setHeader('mcp-session-id', newSessionId);
                }

                await transport.handleRequest(req, res, req.body);
            } catch (err) {
                console.error('MCP request error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message });
                }
            }
        });
    }

    // MCP endpoint - protected by bearer auth
    app.post('/mcp', bearerAuth, handleMcpRequest);
    app.get('/mcp', bearerAuth, handleMcpRequest);

    // Session cleanup
    app.delete('/mcp', bearerAuth, (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        if (sessionId && sessions.has(sessionId)) {
            sessions.delete(sessionId);
        }
        res.status(204).end();
    });

    // Health check (no auth required)
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', sessions: sessions.size });
    });

    // Global error handler
    app.use((err, req, res, next) => {
        console.error('Unhandled error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });

    const httpServer = app.listen(port, () => {
        console.log(`Calq MCP server running on ${baseUrl}/mcp`);
        console.log(`OAuth: ${baseUrl}/oauth/authorize`);
    });

    setupGracefulShutdown(httpServer);
}

main().catch(console.error);

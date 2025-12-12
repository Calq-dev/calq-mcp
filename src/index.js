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
    getSessionSummary
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

// Tool: Commit time and/or a summary to a project
server.tool(
    'commit',
    {
        project: z.string().describe('Name of the project'),
        message: z.string().describe('What was accomplished (like a git commit message)'),
        minutes: z.number().nonnegative().optional().describe('Time spent in minutes (defaults to 0)'),
        billable: z.boolean().optional().describe('Whether this is billable work (defaults to true)'),
        date: z.string().optional().describe('Date for the entry (YYYY-MM-DD format). Defaults to today. Use for backdating or future entries.'),
        task: z.string().optional().describe('Task ID to link this time entry to (syncs to YouTrack if task is linked)')
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

// Tool: Delete an entry
server.tool(
    'delete',
    {
        entry_id: z.string().optional().describe('ID of the entry to delete (deletes last entry if not provided)')
    },
    async ({ entry_id }) => {
        const deleted = await deleteEntry(entry_id || null);

        if (!deleted) {
            return {
                content: [{ type: 'text', text: '❌ No entry found to delete.' }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: `🗑️ Deleted entry from **${deleted.project}**\n\n${deleted.description || '(no message)'}\n⏱️ ${formatDuration(deleted.minutes)}`
            }]
        };
    }
);

// Tool: Edit an entry
server.tool(
    'edit',
    {
        entry_id: z.string().describe('ID of the entry to edit (use get_project_summary to see IDs)'),
        project: z.string().optional().describe('New project name (to move entry)'),
        message: z.string().optional().describe('New message'),
        minutes: z.number().nonnegative().optional().describe('New time in minutes'),
        billable: z.boolean().optional().describe('Set billable status'),
        billed: z.boolean().optional().describe('Mark as billed (true) or unbilled (false)')
    },
    async ({ entry_id, project, message, minutes, billable, billed }) => {
        if (!project && !message && minutes === undefined && billable === undefined && billed === undefined) {
            return {
                content: [{ type: 'text', text: '❌ Provide at least one field to update.' }]
            };
        }

        const updates = {};
        if (project) updates.project = project;
        if (message) updates.message = message;
        if (minutes !== undefined) updates.minutes = minutes;
        if (billable !== undefined) updates.billable = billable;
        if (billed !== undefined) updates.billed = billed;

        const updated = await editEntry(entry_id, updates);

        if (!updated) {
            return {
                content: [{ type: 'text', text: `❌ Entry "${entry_id}" not found.` }]
            };
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
);

// Tool: List all projects
server.tool(
    'list_projects',
    {},
    async () => {
        const projects = await getProjects();

        if (projects.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: '📋 No projects yet. Start tracking time with the log_time tool!'
                }]
            };
        }

        const projectList = projects
            .sort((a, b) => b.totalMinutes - a.totalMinutes)
            .map(p => `• **${p.name}**: ${p.totalFormatted}`)
            .join('\n');

        return {
            content: [{
                type: 'text',
                text: `📋 **Projects** (${projects.length})\n\n${projectList}`
            }]
        };
    }
);

// Tool: Get project summary with recent entries
server.tool(
    'get_project_summary',
    {
        project: z.string().describe('Name of the project to get summary for'),
        limit: z.number().positive().optional().describe('Number of recent entries to show (default: 10)')
    },
    async ({ project, limit }) => {
        const entries = await getProjectEntries(project, limit || 10);
        const projects = await getProjects();
        const projectData = projects.find(p =>
            p.id === project.toLowerCase().trim() ||
            p.name.toLowerCase() === project.toLowerCase()
        );

        if (!projectData) {
            return {
                content: [{
                    type: 'text',
                    text: `❌ Project "${project}" not found. Use list_projects to see available projects.`
                }]
            };
        }

        let text = `📊 **${projectData.name}**\n`;
        text += `⏱️ Total time: ${projectData.totalFormatted}\n\n`;

        if (entries.length === 0) {
            text += '_No entries yet._';
        } else {
            text += `**Recent entries:**\n`;
            for (const entry of entries) {
                const date = new Date(entry.createdAt).toLocaleDateString();
                const icon = entry.type === 'commit' ? '📌' : '⏰';
                text += `${icon} \`${entry.id}\` ${date} - ${entry.durationFormatted}`;
                if (entry.description) {
                    text += `: ${entry.description}`;
                }
                text += '\n';
            }
        }


        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Get today's summary
server.tool(
    'get_today_summary',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const summary = await getTodaySummary(auth.user.id);

        if (summary.projects.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `📅 **Today (${summary.date})**\n\n_No time logged today yet._`
                }]
            };
        }

        let text = `📅 **Today (${summary.date})**\n`;
        text += `⏱️ Total: ${summary.totalFormatted}\n\n`;

        for (const project of summary.projects) {
            text += `**${project.name}**: ${project.durationFormatted}\n`;
            for (const entry of project.entries) {
                const icon = entry.type === 'commit' ? '  📌' : '  •';
                text += `${icon} ${entry.description || '(no description)'}\n`;
            }
            text += '\n';
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Get weekly summary
server.tool(
    'get_weekly_summary',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const summary = await getWeeklySummary(auth.user.id);

        if (summary.days.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `📆 **This Week**\n\n_No time logged this week yet._`
                }]
            };
        }

        let text = `📆 **This Week** (starting ${summary.weekStart})\n`;
        text += `⏱️ Total: ${summary.totalFormatted}\n\n`;

        for (const day of summary.days.sort((a, b) => a.date.localeCompare(b.date))) {
            const dayName = new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' });
            text += `**${dayName} (${day.date})**: ${day.durationFormatted}\n`;
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Get unbilled time summary
server.tool(
    'get_unbilled',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const summary = await getUnbilledSummary(auth.user.id);

        if (summary.projects.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `💰 **Unbilled Time**\n\n_No unbilled billable time._`
                }]
            };
        }

        let text = `💰 **Unbilled Time**\n`;
        text += `⏱️ Total: ${summary.totalFormatted}\n\n`;

        for (const project of summary.projects.sort((a, b) => b.minutes - a.minutes)) {
            text += `**${project.name}**: ${project.durationFormatted} (${project.entries.length} entries)\n`;
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Start a timer
server.tool(
    'start',
    {
        project: z.string().describe('Name of the project to start timing'),
        description: z.string().optional().describe('What you are working on'),
        task: z.string().optional().describe('Task ID to link this timer to')
    },
    async ({ project, description, task }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        // If task is specified, include it in description for reference
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
            return {
                content: [{
                    type: 'text',
                    text: `⚠️ Timer already running on **${result.timer.project}** (${elapsed})\n\n${result.timer.description || ''}\n\nStop it first with the stop tool.`
                }]
            };
        }

        let text = `⏱️ Timer started for **${project}**`;
        if (description) text += `\n\n${description}`;
        if (task) text += `\n📋 Linked to task${taskInfo}`;
        text += `\n\nUse the stop tool when you're done.`;

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Stop the timer
server.tool(
    'stop',
    {
        message: z.string().optional().describe('Final summary message (uses original description if not provided)'),
        billable: z.boolean().optional().describe('Whether this is billable (defaults to true)')
    },
    async ({ message, billable }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const result = await stopTimer(message || null, billable !== false, auth.user.id);

        if (result.error) {
            return {
                content: [{ type: 'text', text: '❌ No timer running. Start one with the start tool.' }]
            };
        }

        let text = `⏹️ Timer stopped - **${result.entry.project}**\n\n${result.entry.description}`;
        text += `\n\n⏱️ ${formatDuration(result.minutes)}`;
        if (result.entry.billable === false) {
            text += `\n🏷️ Non-billable`;
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Check timer status
server.tool(
    'timer_status',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const timer = await getActiveTimer(auth.user.id);

        if (!timer) {
            return {
                content: [{ type: 'text', text: '⏱️ No timer running.' }]
            };
        }

        let statusIcon = timer.isPaused ? '⏸️' : '⏱️';
        let statusText = timer.isPaused ? 'Timer paused' : 'Timer running';
        let text = `${statusIcon} ${statusText}: **${timer.project}** (${timer.elapsedFormatted})`;

        if (timer.description) {
            text += `\n\n${timer.description}`;
        }

        if (timer.totalPausedMinutes > 0) {
            text += `\n\n⏸️ Paused time: ${formatDuration(timer.totalPausedMinutes)}`;
        }

        if (timer.isPaused) {
            text += '\n\nUse resume to continue tracking.';
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Cancel timer without saving
server.tool(
    'cancel_timer',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const timer = await cancelTimer(auth.user.id);

        if (!timer) {
            return {
                content: [{ type: 'text', text: '❌ No timer to cancel.' }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: `🚫 Timer cancelled (not saved)\n\nWas tracking: **${timer.project}**`
            }]
        };
    }
);

// Tool: Pause the timer
server.tool(
    'pause',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const result = await pauseTimer(auth.user.id);

        if (result.error) {
            if (result.error === 'Timer already paused') {
                return {
                    content: [{ type: 'text', text: '⏸️ Timer is already paused. Use resume to continue.' }]
                };
            }
            return {
                content: [{ type: 'text', text: '❌ No timer running to pause.' }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: `⏸️ Timer paused - **${result.project}**\n\n⏱️ ${result.runningFormatted} tracked so far\n\nUse resume to continue.`
            }]
        };
    }
);

// Tool: Resume a paused timer
server.tool(
    'resume',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const result = await resumeTimer(auth.user.id);

        if (result.error) {
            if (result.error === 'Timer is not paused') {
                return {
                    content: [{ type: 'text', text: '▶️ Timer is already running. Use pause to pause it.' }]
                };
            }
            return {
                content: [{ type: 'text', text: '❌ No timer to resume.' }]
            };
        }

        let text = `▶️ Timer resumed - **${result.project}**`;
        if (result.pausedMinutes > 0) {
            text += `\n\nPaused for ${formatDuration(result.pausedMinutes)}`;
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// ==================== MEMORY TOOLS ====================

// Tool: Remember something
server.tool(
    'remember',
    {
        content: z.string().describe('What to remember'),
        category: z.string().optional().describe('Category (e.g. "idea", "note", "decision")'),
        personal: z.boolean().optional().describe('Make this memory private (not shared with team)'),
        project: z.string().optional().describe('Link to a project'),
        client: z.string().optional().describe('Link to a client')
    },
    async ({ content, category, personal, project, client }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            const memory = await storeMemory(content, {
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

            return {
                content: [{ type: 'text', text }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ ${error.message}` }]
            };
        }
    }
);

// Tool: Capture an idea (shortcut for remember with category=idea)
server.tool(
    'idea',
    {
        content: z.string().describe('The idea to capture'),
        project: z.string().optional().describe('Link to a project'),
        client: z.string().optional().describe('Link to a client')
    },
    async ({ content, project, client }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            const memory = await storeMemory(content, {
                category: 'idea',
                shared: true,
                project: project || null,
                client: client || null,
                userId: auth.user.id
            });

            let text = '💡 **Idea captured!**';
            if (project) text += `\n📁 Project: ${project}`;
            if (client) text += `\n👤 Client: ${client}`;
            text += `\n\n${content}`;

            return {
                content: [{ type: 'text', text }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ ${error.message}` }]
            };
        }
    }
);

// Tool: List all ideas
server.tool(
    'list_ideas',
    {
        project: z.string().optional().describe('Filter by project'),
        client: z.string().optional().describe('Filter by client')
    },
    async ({ project, client }) => {
        const memories = await getAllMemories({
            category: 'idea',
            project: project || null,
            client: client || null
        });

        if (memories.length === 0) {
            return {
                content: [{ type: 'text', text: '💡 No ideas yet. Capture one with "idea: your brilliant thought"' }]
            };
        }

        let text = '💡 **Ideas** (' + memories.length + ')\n\n';
        for (const idea of memories.slice(-20).reverse()) {
            const date = new Date(idea.createdAt).toLocaleDateString();
            let meta = [];
            if (idea.projectId) meta.push('📁 ' + idea.projectId);
            if (idea.clientId) meta.push('👤 ' + idea.clientId);
            text += '• `' + idea.id + '` ' + idea.content.substring(0, 80) + (idea.content.length > 80 ? '...' : '') + (meta.length ? ' [' + meta.join(', ') + ']' : '') + ' - ' + date + '\n';
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Recall memories
server.tool(
    'recall',
    {
        query: z.string().describe('What to search for in your memories'),
        project: z.string().optional().describe('Filter by project'),
        client: z.string().optional().describe('Filter by client')
    },
    async ({ query, project, client }) => {
        try {
            const memories = await searchMemories(query, {
                limit: 5,
                project: project || null,
                client: client || null
            });

            if (memories.length === 0) {
                return {
                    content: [{ type: 'text', text: `🧠 No memories found for: "${query}"` }]
                };
            }

            let text = `🧠 **Memories matching: "${query}"**\n\n`;
            for (const memory of memories) {
                const date = new Date(memory.createdAt).toLocaleDateString();
                const score = memory.relevanceScore ? ` (${(memory.relevanceScore * 100).toFixed(0)}%)` : '';
                let meta = [];
                if (memory.category) meta.push(memory.category);
                if (memory.projectId) meta.push(`📁 ${memory.projectId}`);
                if (!memory.shared) meta.push('🔒 personal');
                text += `• ${memory.content}${meta.length ? ` [${meta.join(', ')}]` : ''} - ${date}${score}\n\n`;
            }

            return {
                content: [{ type: 'text', text }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ ${error.message}` }]
            };
        }
    }
);

// Tool: Search time entries semantically
server.tool(
    'search_entries',
    {
        query: z.string().describe('What to search for in your time entries')
    },
    async ({ query }) => {
        try {
            const entries = await searchEntries(query, 10);

            if (entries.length === 0) {
                return {
                    content: [{ type: 'text', text: `🔍 No entries found for: "${query}"` }]
                };
            }

            let text = `🔍 **Entries matching: "${query}"**\n\n`;
            for (const entry of entries) {
                const date = new Date(entry.createdAt).toLocaleDateString();
                const score = entry.relevanceScore ? ` (${(entry.relevanceScore * 100).toFixed(0)}%)` : '';
                text += `• **${entry.projectName}** - ${date} - ${entry.durationFormatted}${score}\n  ${entry.description}\n\n`;
            }

            return {
                content: [{ type: 'text', text }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ ${error.message}` }]
            };
        }
    }
);

// Tool: List all memories
// Tool: List memories
server.tool(
    'list_memories',
    {
        category: z.string().optional().describe('Filter by category'),
        project: z.string().optional().describe('Filter by project'),
        client: z.string().optional().describe('Filter by client'),
        personal: z.boolean().optional().describe('Show only personal memories')
    },
    async ({ category, project, client, personal }) => {
        const memories = await getAllMemories({
            category: category || null,
            project: project || null,
            client: client || null,
            personal: personal || false
        });

        if (memories.length === 0) {
            return {
                content: [{ type: 'text', text: `🧠 No memories found.` }]
            };
        }

        let text = `🧠 **Memories** (${memories.length})\n\n`;
        for (const memory of memories.slice(-20).reverse()) {
            const date = new Date(memory.createdAt).toLocaleDateString();
            let meta = [];
            if (memory.category) meta.push(memory.category);
            if (memory.projectId) meta.push(`📁 ${memory.projectId}`);
            if (memory.clientId) meta.push(`👤 ${memory.clientId}`);
            if (!memory.shared) meta.push('🔒');
            text += `• \`${memory.id}\` ${memory.content.substring(0, 80)}${memory.content.length > 80 ? '...' : ''}${meta.length ? ` [${meta.join(', ')}]` : ''} - ${date}\n`;
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Delete a memory
server.tool(
    'forget',
    {
        memory_id: z.string().describe('ID of the memory to delete (use list_memories to see IDs)')
    },
    async ({ memory_id }) => {
        const deleted = await deleteMemory(memory_id);

        if (!deleted) {
            return {
                content: [{ type: 'text', text: `❌ Memory "${memory_id}" not found.` }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: `🗑️ Forgot: ${deleted.content.substring(0, 100)}${deleted.content.length > 100 ? '...' : ''}`
            }]
        };
    }
);

// ==================== CLIENT TOOLS ====================

// Tool: Add a client
server.tool(
    'add_client',
    {
        name: z.string().describe('Client name'),
        email: z.string().optional().describe('Client email'),
        notes: z.string().optional().describe('Notes about the client')
    },
    async ({ name, email, notes }) => {
        const result = await createClient(name, email || '', notes || '');

        if (result.error) {
            return {
                content: [{ type: 'text', text: `⚠️ ${result.error}: ${result.client.name}` }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: `👤 Client added: **${result.name}**${email ? `\n📧 ${email}` : ''}`
            }]
        };
    }
);

// Tool: List clients
server.tool(
    'list_clients',
    {},
    async () => {
        const clients = await getClients();

        if (clients.length === 0) {
            return {
                content: [{ type: 'text', text: '👥 No clients yet. Add one with add_client.' }]
            };
        }

        let text = `👥 **Clients** (${clients.length})\n\n`;
        for (const client of clients) {
            text += `• **${client.name}**${client.email ? ` - ${client.email}` : ''}\n`;
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// ==================== PROJECT TOOLS ====================

// Tool: Create/configure a project
server.tool(
    'configure_project',
    {
        name: z.string().describe('Project name'),
        client: z.string().optional().describe('Client name to link'),
        hourly_rate: z.number().optional().describe('Hourly rate for billing'),
        notes: z.string().optional().describe('Project notes')
    },
    async ({ name, client, hourly_rate, notes }) => {
        const project = await createProject(name, client || null, hourly_rate || 0, notes || '');

        let text = `📁 Project configured: **${project.name}**`;
        if (project.clientId) text += `\n👤 Client: ${project.clientId}`;
        if (project.hourlyRate) text += `\n💰 Rate: €${project.hourlyRate}/hr`;

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: List projects with client info
server.tool(
    'list_projects_detailed',
    {
        client: z.string().optional().describe('Filter by client name')
    },
    async ({ client }) => {
        const projects = await getProjectsWithClients(client || null);

        if (projects.length === 0) {
            return {
                content: [{ type: 'text', text: `📁 No projects${client ? ` for client "${client}"` : ''}.` }]
            };
        }

        let text = `📁 **Projects** (${projects.length})${client ? ` [${client}]` : ''}\n\n`;
        for (const p of projects.sort((a, b) => (b.totalMinutes || 0) - (a.totalMinutes || 0))) {
            text += `• **${p.name}** - ${p.totalFormatted}`;
            if (p.clientName) text += ` (${p.clientName})`;
            if (p.hourlyRate) text += ` - €${p.hourlyRate}/hr`;
            if (p.estimatedValue) text += ` ≈ €${p.estimatedValue}`;
            text += '\n';
        }

        return {
            content: [{ type: 'text', text }]
        };
    }
);

// Tool: Get unbilled time grouped by client with values
server.tool(
    'get_invoice_summary',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const summary = await getUnbilledByClient(auth.user.id);

        if (summary.clients.length === 0) {
            return {
                content: [{ type: 'text', text: '💰 No unbilled time.' }]
            };
        }

        let text = `💰 **Invoice Summary**\n`;
        text += `⏱️ Total: ${summary.totalFormatted} | €${summary.totalValue}\n\n`;

        for (const client of summary.clients.sort((a, b) => b.value - a.value)) {
            text += `**${client.clientName}**: ${client.durationFormatted} - €${client.valueFormatted}\n`;
            for (const project of client.projects) {
                text += `  • ${project.projectName}: ${project.durationFormatted}`;
                if (project.hourlyRate) text += ` (€${project.hourlyRate}/hr = €${project.valueFormatted})`;
                text += '\n';
            }
            text += '\n';
        }

        return {
            content: [{ type: 'text', text }]
        };
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

// Tool: Get current user info
server.tool(
    'whoami',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: '🔒 ' + auth.error }] };
        }

        const user = auth.user;
        return {
            content: [{
                type: 'text',
                text: '👤 **' + user.username + '**\n📧 ' + user.email + '\n🏷️ Role: ' + user.role + '\n📅 Last login: ' + (user.lastLogin || 'Never')
            }]
        };
    }
);

// Tool: List all users (admin only)
server.tool(
    'list_users',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: '🔒 ' + auth.error }] };
        }

        if (auth.user.role !== 'admin') {
            return { content: [{ type: 'text', text: '🔒 Admin access required' }] };
        }

        const users = await getUsers();

        if (users.length === 0) {
            return { content: [{ type: 'text', text: '👥 No users yet. Complete OAuth authentication first.' }] };
        }

        let text = '👥 **Users** (' + users.length + ')\n\n';
        for (const user of users) {
            const role = user.role === 'admin' ? '👑' : '👤';
            const lastLogin = user.lastLogin ? ' (last: ' + new Date(user.lastLogin).toLocaleDateString() + ')' : '';
            text += role + ' **' + user.username + '** - ' + user.email + lastLogin + '\n';
        }

        return { content: [{ type: 'text', text }] };
    }
);

// Tool: Set user role (admin only)
server.tool(
    'set_user_role',
    {
        username: z.string().describe('Username to update'),
        role: z.enum(['admin', 'member']).describe('New role')
    },
    async ({ username, role }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: '🔒 ' + auth.error }] };
        }

        if (auth.user.role !== 'admin') {
            return { content: [{ type: 'text', text: '🔒 Admin access required' }] };
        }

        const updated = await updateUserAuth(username, { role });

        if (!updated) {
            return { content: [{ type: 'text', text: '❌ User "' + username + '" not found' }] };
        }

        const roleIcon = role === 'admin' ? '👑 admin' : '👤 member';
        return {
            content: [{
                type: 'text',
                text: '✅ ' + updated.username + ' is now ' + roleIcon
            }]
        };
    }
);

// Tool: Get team activity summary
server.tool(
    'team_summary',
    {},
    async () => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: '🔒 ' + auth.error }] };
        }

        const summary = await getTeamTodaySummary();

        let text = '👥 **Team Summary** (' + new Date().toLocaleDateString() + ')\n\n';

        if (summary.members.length === 0) {
            text += '_No time logged today yet._\n';
        } else {
            for (const member of summary.members) {
                text += '**' + member.username + '** - ' + member.totalFormatted + ' total\n';
                for (const project of member.projects) {
                    text += '  • ' + project.name + ': ' + project.durationFormatted + '\n';
                }
                text += '\n';
            }
        }

        text += '👥 ' + summary.members.length + ' team member' + (summary.members.length !== 1 ? 's' : '') + ' active today\n';
        text += '⏱️ Team total: ' + summary.teamTotalFormatted;

        return { content: [{ type: 'text', text }] };
    }
);

// ==================== TASK TOOLS ====================

// Tool: List tasks
server.tool(
    'tasks',
    {
        status: z.enum(['open', 'done', 'all']).optional().describe('Filter by status (default: open)'),
        project: z.string().optional().describe('Filter by project'),
        mine: z.boolean().optional().describe('Show only my tasks')
    },
    async ({ status, project, mine }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const taskList = await getTasks({
            status: status || 'open',
            project: project || null,
            mine: mine || false
        });

        if (taskList.length === 0) {
            const statusText = status === 'all' ? '' : (status || 'open');
            return {
                content: [{ type: 'text', text: `📋 No ${statusText} tasks${project ? ` for ${project}` : ''}.` }]
            };
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
);

// Tool: Add a task
server.tool(
    'add_task',
    {
        title: z.string().describe('Task title'),
        project: z.string().optional().describe('Link to a project'),
        issue: z.string().optional().describe('YouTrack issue ID (e.g., "PROJ-123")')
    },
    async ({ title, project, issue }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const task = await createTask(title, project || null, issue || null, auth.user.id);

        let text = `📋 Task added: **${task.title}**`;
        if (task.projectId) text += `\n📁 Project: ${task.projectId}`;
        if (task.youtrackId) text += `\n🔗 YouTrack: ${task.youtrackId}`;

        return { content: [{ type: 'text', text }] };
    }
);

// Tool: Complete a task
server.tool(
    'complete_task',
    {
        id: z.string().describe('Task ID'),
        log_time: z.number().optional().describe('Minutes to log when completing')
    },
    async ({ id, log_time }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        // Get task first to check if it has YouTrack link
        const task = await getTask(id);
        if (!task) {
            return { content: [{ type: 'text', text: `❌ Task "${id}" not found.` }] };
        }

        // Complete the task locally
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

                    // Log time if specified
                    if (log_time && log_time > 0) {
                        await yt.addWorkItem(task.youtrackId, log_time, `Completed: ${task.title}`);
                        text += `\n⏱️ Logged ${formatDuration(log_time)} to YouTrack`;
                    }

                    // Resolve the issue in YouTrack
                    await yt.resolveIssue(task.youtrackId);
                    text += `\n🔗 YouTrack ${task.youtrackId} resolved`;
                } else {
                    text += `\n⚠️ YouTrack not synced (no token). Use connect_youtrack to link your account.`;
                }
            } catch (error) {
                text += `\n⚠️ YouTrack sync failed: ${error.message}`;
            }
        }

        return { content: [{ type: 'text', text }] };
    }
);

// ==================== YOUTRACK TOOLS ====================

// Tool: Connect YouTrack account
server.tool(
    'connect_youtrack',
    {
        token: z.string().describe('Your YouTrack API token (permanent token from YouTrack profile)')
    },
    async ({ token }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            // Verify the token works by making a test request
            const yt = getYouTrackClient(token);
            await yt.getIssues('', null, 'me');

            // Save the token
            await setUserYouTrackToken(auth.user.id, token);

            return {
                content: [{ type: 'text', text: `🔗 YouTrack connected! You can now use \`issues\` to fetch your tasks.` }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Failed to connect: ${error.message}` }]
            };
        }
    }
);

// Tool: Fetch issues from YouTrack (syncs to local tasks)
server.tool(
    'issues',
    {
        query: z.string().optional().describe('YouTrack search query'),
        project: z.string().optional().describe('Filter by YouTrack project'),
        assignee: z.enum(['me', 'all']).optional().describe('Filter by assignee (default: me)')
    },
    async ({ query, project, assignee }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const token = await getUserYouTrackToken(auth.user.id);
        if (!token) {
            return {
                content: [{ type: 'text', text: `🔗 YouTrack not connected. Use \`connect_youtrack\` with your API token first.` }]
            };
        }

        try {
            const yt = getYouTrackClient(token);
            const issues = await yt.getIssues(query || '', project || null, assignee || 'me');

            if (issues.length === 0) {
                return {
                    content: [{ type: 'text', text: `📋 No issues found${project ? ` in ${project}` : ''}.` }]
                };
            }

            // Sync issues to local tasks
            let syncedCount = 0;
            for (const issue of issues) {
                const status = issue.resolved ? 'done' : 'open';
                // Use project shortname as local project if available
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
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ YouTrack error: ${error.message}` }]
            };
        }
    }
);

// Tool: Get issue details, update status, add comment
server.tool(
    'issue',
    {
        id: z.string().describe('YouTrack issue ID (e.g., "PROJ-123")'),
        action: z.enum(['get', 'comment', 'resolve']).optional().describe('Action to perform (default: get)'),
        comment: z.string().optional().describe('Comment text (for comment action)')
    },
    async ({ id, action, comment }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const token = await getUserYouTrackToken(auth.user.id);
        if (!token) {
            return {
                content: [{ type: 'text', text: `🔗 YouTrack not connected. Use \`connect_youtrack\` with your API token first.` }]
            };
        }

        try {
            const yt = getYouTrackClient(token);
            const actionType = action || 'get';

            if (actionType === 'get') {
                const issue = await yt.getIssue(id);
                let text = `📋 **${issue.id}** - ${issue.summary}\n\n`;
                text += `🏷️ State: ${issue.state}\n`;
                text += `📁 Project: ${issue.projectName || issue.project}\n`;
                if (issue.description) {
                    text += `\n${issue.description.substring(0, 500)}${issue.description.length > 500 ? '...' : ''}`;
                }
                return { content: [{ type: 'text', text }] };
            }

            if (actionType === 'comment') {
                if (!comment) {
                    return { content: [{ type: 'text', text: `❌ Comment text required.` }] };
                }
                await yt.addComment(id, comment);
                return { content: [{ type: 'text', text: `💬 Comment added to ${id}` }] };
            }

            if (actionType === 'resolve') {
                await yt.resolveIssue(id);

                // Also update local task if it exists
                const status = 'done';
                const issue = await yt.getIssue(id);
                await upsertTaskFromYouTrack(id, issue.summary, issue.description || '', status, null, auth.user.id);

                return { content: [{ type: 'text', text: `✅ Resolved ${id}` }] };
            }

            return { content: [{ type: 'text', text: `❌ Unknown action: ${actionType}` }] };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ YouTrack error: ${error.message}` }]
            };
        }
    }
);

// ==================== OBSERVATION TOOLS ====================

// Tool: Store an observation from a Claude Code session
server.tool(
    'observe',
    {
        session_id: z.string().describe('Claude session ID'),
        project: z.string().describe('Project name or path'),
        type: z.enum(['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change']).describe('Type of observation'),
        title: z.string().describe('Short title for the observation'),
        subtitle: z.string().optional().describe('One sentence explanation'),
        narrative: z.string().optional().describe('Full context explanation'),
        facts: z.array(z.string()).optional().describe('Array of self-contained fact statements'),
        concepts: z.array(z.enum(['how-it-works', 'why-it-exists', 'problem-solution', 'gotcha', 'pattern', 'trade-off'])).optional().describe('Concept tags'),
        files_read: z.array(z.string()).optional().describe('Files that were read'),
        files_modified: z.array(z.string()).optional().describe('Files that were modified'),
        tool_name: z.string().optional().describe('Tool that triggered this observation'),
        tool_input: z.string().optional().describe('Tool input (sanitized)')
    },
    async ({ session_id, project, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, tool_name, tool_input }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            const observation = await createObservation({
                sessionId: session_id,
                userId: auth.user.id,
                project,
                type,
                title,
                subtitle,
                narrative,
                facts,
                concepts,
                filesRead: files_read,
                filesModified: files_modified,
                toolName: tool_name,
                toolInput: tool_input
            });

            return {
                content: [{ type: 'text', text: `📝 Observation stored: ${title}` }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Failed to store observation: ${error.message}` }]
            };
        }
    }
);

// Tool: Create a session summary
server.tool(
    'summarize_session',
    {
        session_id: z.string().describe('Claude session ID'),
        project: z.string().describe('Project name or path'),
        request: z.string().describe('What the user asked for'),
        investigated: z.string().optional().describe('What was looked into'),
        learned: z.string().optional().describe('Key insights discovered'),
        completed: z.string().optional().describe('What was delivered'),
        next_steps: z.string().optional().describe('Recommended follow-ups'),
        notes: z.string().optional().describe('Additional context'),
        files_read: z.array(z.string()).optional().describe('Files that were read'),
        files_edited: z.array(z.string()).optional().describe('Files that were edited')
    },
    async ({ session_id, project, request, investigated, learned, completed, next_steps, notes, files_read, files_edited }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            const summary = await createSessionSummary({
                sessionId: session_id,
                userId: auth.user.id,
                project,
                request,
                investigated,
                learned,
                completed,
                nextSteps: next_steps,
                notes,
                filesRead: files_read,
                filesEdited: files_edited
            });

            return {
                content: [{ type: 'text', text: `📋 Session summary saved for: ${request.slice(0, 50)}...` }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Failed to save summary: ${error.message}` }]
            };
        }
    }
);

// Tool: Get context for a session (observations + summaries)
server.tool(
    'get_context',
    {
        project: z.string().describe('Project name or path'),
        limit: z.number().optional().describe('Max observations to return (default: 20)'),
        include_summaries: z.boolean().optional().describe('Include recent session summaries (default: true)')
    },
    async ({ project, limit, include_summaries }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            const maxObs = limit || 20;
            const includeSummaries = include_summaries !== false;

            // Get recent observations for this project
            const obs = await getObservations({
                project,
                userId: auth.user.id,
                limit: maxObs
            });

            // Get recent session summaries
            const summaries = includeSummaries ? await getSessionSummaries({
                project,
                userId: auth.user.id,
                limit: 5
            }) : [];

            if (obs.length === 0 && summaries.length === 0) {
                return {
                    content: [{ type: 'text', text: `📭 No context found for project: ${project}` }]
                };
            }

            // Format context for injection
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

                // Group by type
                const typeIcons = {
                    bugfix: '🐛',
                    feature: '✨',
                    refactor: '♻️',
                    discovery: '🔍',
                    decision: '🎯',
                    change: '📝'
                };

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
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Failed to get context: ${error.message}` }]
            };
        }
    }
);

// Tool: Search observations
server.tool(
    'search_observations',
    {
        query: z.string().describe('Search query'),
        project: z.string().optional().describe('Filter by project'),
        type: z.enum(['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change']).optional().describe('Filter by type'),
        limit: z.number().optional().describe('Max results (default: 10)')
    },
    async ({ query, project, type, limit }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        try {
            const results = await searchObservations(query, {
                project,
                type,
                userId: auth.user.id,
                limit: limit || 10
            });

            if (results.length === 0) {
                return {
                    content: [{ type: 'text', text: `🔍 No observations found for: "${query}"` }]
                };
            }

            const typeIcons = {
                bugfix: '🐛',
                feature: '✨',
                refactor: '♻️',
                discovery: '🔍',
                decision: '🎯',
                change: '📝'
            };

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
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Search failed: ${error.message}` }]
            };
        }
    }
);

// ==================== INSTALL TOOL ====================

// Tool: Get Claude Code configuration files (hooks, commands, skills)
server.tool(
    'install',
    {
        include_hooks: z.boolean().optional().describe('Include hooks for automatic observation capture (default: true)'),
        include_commands: z.boolean().optional().describe('Include slash commands (default: true)'),
        include_skills: z.boolean().optional().describe('Include skills (default: true)')
    },
    async ({ include_hooks, include_commands, include_skills }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const includeHooks = include_hooks !== false;
        const includeCommands = include_commands !== false;
        const includeSkills = include_skills !== false;

        const baseUrl = process.env.BASE_URL || 'https://mcp.calq.nl';

        const files = {};

        if (includeHooks) {
            // Hooks configuration
            files['.claude/hooks/hooks.json'] = JSON.stringify({
                hooks: {
                    PostToolUse: [{
                        type: "command",
                        command: `node .claude/hooks/calq-observe.js "$TOOL_NAME" "$TOOL_INPUT" "$TOOL_OUTPUT" "$SESSION_ID" "$CWD"`,
                        description: "Send tool observations to Calq"
                    }],
                    Stop: [{
                        type: "command",
                        command: `node .claude/hooks/calq-summary.js "$SESSION_ID" "$CWD" "$TRANSCRIPT_PATH"`,
                        description: "Generate session summary in Calq"
                    }],
                    SessionStart: [{
                        type: "command",
                        command: `node .claude/hooks/calq-context.js "$SESSION_ID" "$CWD"`,
                        description: "Inject Calq context into session"
                    }]
                }
            }, null, 2);

            // PostToolUse hook script
            files['.claude/hooks/calq-observe.js'] = `#!/usr/bin/env node
// Calq observation hook - sends tool outputs to Calq MCP for learning extraction
const [,, toolName, toolInput, toolOutput, sessionId, cwd] = process.argv;

const CALQ_URL = process.env.CALQ_MCP_URL || '${baseUrl}/mcp';
const CALQ_TOKEN = process.env.CALQ_TOKEN;

if (!CALQ_TOKEN) {
    console.error('CALQ_TOKEN not set, skipping observation');
    process.exit(0);
}

// Skip certain tools that don't need observation
const skipTools = ['TodoRead', 'TodoWrite', 'AskFollowupQuestion'];
if (skipTools.includes(toolName)) process.exit(0);

// Fire and forget - don't block Claude
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

            // Stop hook script (session summary)
            files['.claude/hooks/calq-summary.js'] = `#!/usr/bin/env node
// Calq session summary hook
const [,, sessionId, cwd, transcriptPath] = process.argv;
const fs = require('fs');

const CALQ_URL = process.env.CALQ_MCP_URL || '${baseUrl}/mcp';
const CALQ_TOKEN = process.env.CALQ_TOKEN;

if (!CALQ_TOKEN) process.exit(0);

// Read transcript to extract what was done
let request = 'Session completed';
try {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
        const transcript = fs.readFileSync(transcriptPath, 'utf8');
        // Extract first user message as request
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
            arguments: {
                session_id: sessionId,
                project: cwd.split('/').pop(),
                request
            }
        },
        id: Date.now()
    })
}).catch(() => {});
`;

            // SessionStart hook (context injection)
            files['.claude/hooks/calq-context.js'] = `#!/usr/bin/env node
// Calq context injection hook
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
            arguments: {
                project,
                limit: 15
            }
        },
        id: Date.now()
    })
})
.then(r => r.json())
.then(data => {
    if (data.result?.content?.[0]?.text) {
        // Output context for Claude to see
        console.log('<calq-context>');
        console.log(data.result.content[0].text);
        console.log('</calq-context>');
    }
})
.catch(() => {});
`;
        }

        if (includeCommands) {
            // Slash commands
            files['.claude/commands/calq-status.md'] = `---
description: Show your Calq time tracking status
---

Use the Calq MCP to show my current timer status and today's time summary. Call the \`timer\` and \`today\` tools.`;

            files['.claude/commands/calq-log.md'] = `---
description: Log time to a project
---

Log time to a project using Calq. Ask me which project and how much time, then use the \`commit\` tool to log it.

Example: "Log 2 hours to project-name for implementing feature X"`;

            files['.claude/commands/calq-tasks.md'] = `---
description: Show your tasks
---

Show my current tasks from Calq. Use the \`tasks\` tool to list them.`;
        }

        if (includeSkills) {
            // Skills
            files['.claude/skills/calq-remember.md'] = `---
description: Remember something for later using Calq
---

When the user wants to remember something:
1. Use the Calq MCP \`remember\` tool to store the memory
2. Optionally categorize it (decision, learning, note, todo)
3. Confirm what was saved`;
        }

        // Format output
        let text = `# Calq Configuration Files\n\n`;
        text += `The following files should be created in your project:\n\n`;

        for (const [path, content] of Object.entries(files)) {
            text += `## \`${path}\`\n\n`;
            text += '```' + (path.endsWith('.json') ? 'json' : path.endsWith('.js') ? 'javascript' : 'markdown') + '\n';
            text += content;
            text += '\n```\n\n';
        }

        text += `## Setup Instructions\n\n`;
        text += `1. Create the files above in your project\n`;
        text += `2. Set your Calq token: \`export CALQ_TOKEN=your_token_here\`\n`;
        text += `3. The hooks will automatically capture observations and inject context\n`;

        return { content: [{ type: 'text', text }] };
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

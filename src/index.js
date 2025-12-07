#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
    formatDuration,
    deleteEntry,
    editEntry,
    getLastEntry,
    getUnbilledSummary,
    startTimer,
    stopTimer,
    getActiveTimer,
    cancelTimer,
    createClient,
    getClients,
    updateClient,
    deleteClient,
    createProject,
    getProjectsWithClients,
    updateProject,
    getUnbilledByClient
} from './storage.js';
import {
    storeMemory,
    searchMemories,
    searchEntries,
    deleteMemory,
    getAllMemories
} from './memory.js';
import {
    getUsers,
    getUser,
    updateUser as updateUserAuth,
    deleteUser as deleteUserAuth,
    getAuthUrl,
    getMcpSessionFromState,
    handleOAuthCallback
} from './auth.js';

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
        date: z.string().optional().describe('Date for the entry (YYYY-MM-DD format). Defaults to today. Use for backdating or future entries.')
    },
    async ({ project, message, minutes, billable, date }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const entry = addEntry(project, minutes || 0, message, 'commit', billable !== false, date || null, auth.user.id);

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
        const deleted = deleteEntry(entry_id || null);

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

        const updated = editEntry(entry_id, updates);

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
        const projects = getProjects();

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
        const entries = getProjectEntries(project, limit || 10);
        const projects = getProjects();
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

        const summary = getTodaySummary(auth.user.id);

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

        const summary = getWeeklySummary(auth.user.id);

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

        const summary = getUnbilledSummary(auth.user.id);

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
        description: z.string().optional().describe('What you are working on')
    },
    async ({ project, description }) => {
        const auth = checkUser();
        if (auth.error) {
            return { content: [{ type: 'text', text: `🔒 ${auth.error}` }] };
        }

        const result = startTimer(project, description || '', auth.user.id);

        if (result.error) {
            const elapsed = formatDuration(Math.round((new Date() - new Date(result.timer.startedAt)) / 60000));
            return {
                content: [{
                    type: 'text',
                    text: `⚠️ Timer already running on **${result.timer.project}** (${elapsed})\n\n${result.timer.description || ''}\n\nStop it first with the stop tool.`
                }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: `⏱️ Timer started for **${project}**${description ? `\n\n${description}` : ''}\n\nUse the stop tool when you're done.`
            }]
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

        const result = stopTimer(message || null, billable !== false, auth.user.id);

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

        const timer = getActiveTimer(auth.user.id);

        if (!timer) {
            return {
                content: [{ type: 'text', text: '⏱️ No timer running.' }]
            };
        }

        return {
            content: [{
                type: 'text',
                text: `⏱️ Timer running: **${timer.project}** (${timer.elapsedFormatted})\n\n${timer.description || ''}`
            }]
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

        const timer = cancelTimer(auth.user.id);

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
        try {
            const memory = await storeMemory(content, {
                category: category || '',
                shared: !personal,
                project: project || null,
                client: client || null
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
        try {
            const memory = await storeMemory(content, {
                category: 'idea',
                shared: true,
                project: project || null,
                client: client || null
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
        const memories = getAllMemories({
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
        const memories = getAllMemories({
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
        const deleted = deleteMemory(memory_id);

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
        const result = createClient(name, email || '', notes || '');

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
        const clients = getClients();

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
        const project = createProject(name, client || null, hourly_rate || 0, notes || '');

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
        const projects = getProjectsWithClients(client || null);

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

        const summary = getUnbilledByClient(auth.user.id);

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

        const users = getUsers();

        if (users.length === 0) {
            return { content: [{ type: 'text', text: '👥 No users yet. Login at http://localhost:3847' }] };
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

        const updated = updateUserAuth(username, { role });

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

        const today = getTodaySummary(auth.user.id);
        const users = getUsers();

        let text = '👥 **Team Summary** (' + new Date().toLocaleDateString() + ')\n';
        text += '⏱️ Your total today: ' + today.totalFormatted + '\n\n';

        for (const project of today.projects) {
            text += '**' + project.name + '**: ' + project.durationFormatted + '\n';
        }

        text += '\n👥 ' + users.length + ' team members registered';

        return { content: [{ type: 'text', text }] };
    }
);

// Start the server
async function main() {
    const port = parseInt(process.env.MCP_PORT || '3000');

    const app = express();
    app.use(express.json());

    // Store sessions
    const sessions = new Map();

    // Store pending auth sessions (MCP session ID -> auth state)
    const pendingAuth = new Map();

    // OAuth metadata endpoint (RFC 8414) - tells Claude Desktop where to auth
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
        const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
        res.json({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/oauth/authorize`,
            token_endpoint: `${baseUrl}/oauth/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256']
        });
    });

    // MCP endpoint - HTTP streaming only
    app.post('/mcp', async (req, res) => {
        const sessionId = req.headers['mcp-session-id'];

        let transport;
        let newSessionId;
        let user = null;

        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            transport = session.transport;
            user = session.user;
        } else {
            // Create new session
            newSessionId = crypto.randomUUID();
            transport = new StreamableHTTPServerTransport({
                sessionId: newSessionId
            });

            // Check if this session completed OAuth
            if (pendingAuth.has(newSessionId)) {
                user = pendingAuth.get(newSessionId);
                pendingAuth.delete(newSessionId);
            }

            sessions.set(newSessionId, { transport, user });
            await server.connect(transport);
        }

        // Run request with user context
        await requestContext.run({ user }, async () => {
            try {
                const response = await transport.handleRequest(req.body);

                if (newSessionId) {
                    res.setHeader('mcp-session-id', newSessionId);
                }

                res.json(response);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
    });

    // OAuth initiation endpoint
    app.get('/oauth/authorize', (req, res) => {
        const { session_id } = req.query;

        try {
            // getAuthUrl stores session_id with the state internally
            const { url } = getAuthUrl(session_id || null);
            res.redirect(url);
        } catch (error) {
            res.status(500).send(`OAuth setup failed: ${error.message}`);
        }
    });

    // OAuth callback endpoint - links OAuth result to MCP session
    app.get('/oauth/callback', async (req, res) => {
        const { code, state } = req.query;

        if (!code || !state) {
            res.status(400).send('Missing code or state');
            return;
        }

        try {
            // Get MCP session ID from the state before it's consumed
            const mcpSessionId = getMcpSessionFromState(state);

            // Handle the OAuth callback (validates state, exchanges code for token)
            const result = await handleOAuthCallback(code, state);

            // Link user to MCP session
            if (mcpSessionId && sessions.has(mcpSessionId)) {
                const session = sessions.get(mcpSessionId);
                session.user = result.user;
            } else if (mcpSessionId) {
                pendingAuth.set(mcpSessionId, result.user);
            }

            res.send(`
                <!DOCTYPE html>
                <html>
                <head><title>Calq - Authenticated</title></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                    <h1>✅ Authenticated as ${result.user.username}</h1>
                    <p>You can close this window and return to Claude.</p>
                </body>
                </html>
            `);
        } catch (error) {
            res.status(500).send(`Authentication failed: ${error.message}`);
        }
    });

    // Session cleanup
    app.delete('/mcp', (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        if (sessionId && sessions.has(sessionId)) {
            sessions.delete(sessionId);
        }
        res.status(204).end();
    });

    // Health check
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', sessions: sessions.size });
    });

    app.listen(port, () => {
        console.error(`Calq MCP server running on http://localhost:${port}/mcp`);
        console.error(`OAuth: http://localhost:${port}/oauth/authorize`);
    });
}

main().catch(console.error);

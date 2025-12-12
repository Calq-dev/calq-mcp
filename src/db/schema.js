import { pgTable, text, integer, boolean, timestamp, real, index } from 'drizzle-orm/pg-core';

// Users table - team members with GitHub OAuth
export const users = pgTable('users', {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email'),
    role: text('role').default('member'),
    githubId: text('github_id'),
    youtrackToken: text('youtrack_token'),
    createdAt: timestamp('created_at').defaultNow(),
    lastLogin: timestamp('last_login'),
});

// Clients table
export const clients = pgTable('clients', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow(),
});

// Projects table
export const projects = pgTable('projects', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    clientId: text('client_id').references(() => clients.id),
    hourlyRate: real('hourly_rate').default(0),
    notes: text('notes'),
    totalMinutes: integer('total_minutes').default(0),
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_projects_client').on(table.clientId),
]);

// Tasks table - local tasks with optional YouTrack sync
export const tasks = pgTable('tasks', {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    userId: text('user_id').references(() => users.id),
    projectId: text('project_id').references(() => projects.id),
    youtrackId: text('youtrack_id'),  // e.g., "PROJ-123"
    status: text('status').default('open'),  // 'open', 'done'
    syncedAt: timestamp('synced_at'),
    createdAt: timestamp('created_at').defaultNow(),
    completedAt: timestamp('completed_at'),
}, (table) => [
    index('idx_tasks_user').on(table.userId),
    index('idx_tasks_project').on(table.projectId),
    index('idx_tasks_youtrack').on(table.youtrackId),
    index('idx_tasks_status').on(table.status),
]);

// Entries table - time entries
export const entries = pgTable('entries', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id),
    minutes: integer('minutes').notNull(),
    description: text('description'),
    type: text('type').default('commit'),
    billable: boolean('billable').default(true),
    billed: boolean('billed').default(false),
    userId: text('user_id').references(() => users.id),
    taskId: text('task_id').references(() => tasks.id),
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_entries_project').on(table.projectId),
    index('idx_entries_user').on(table.userId),
    index('idx_entries_task').on(table.taskId),
    index('idx_entries_created').on(table.createdAt),
]);

// Memories table - metadata only, vectors in ChromaDB
export const memories = pgTable('memories', {
    id: text('id').primaryKey(),
    content: text('content').notNull(),
    category: text('category'),
    shared: boolean('shared').default(true),
    projectId: text('project_id').references(() => projects.id),
    clientId: text('client_id').references(() => clients.id),
    userId: text('user_id').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_memories_user').on(table.userId),
    index('idx_memories_category').on(table.category),
]);

// Active timer table - one per user
export const activeTimer = pgTable('active_timer', {
    userId: text('user_id').primaryKey().references(() => users.id),
    projectId: text('project_id').references(() => projects.id),
    description: text('description'),
    startedAt: timestamp('started_at'),
    pausedAt: timestamp('paused_at'),
    pausedDuration: integer('paused_duration').default(0), // Total paused time in minutes
});

// OAuth registered clients
export const oauthClients = pgTable('oauth_clients', {
    clientId: text('client_id').primaryKey(),
    clientSecret: text('client_secret'),
    clientName: text('client_name'),
    redirectUris: text('redirect_uris'), // JSON array
    clientIdIssuedAt: integer('client_id_issued_at'),
    createdAt: timestamp('created_at').defaultNow(),
});

// OAuth access tokens
export const oauthAccessTokens = pgTable('oauth_access_tokens', {
    token: text('token').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: text('user_id').references(() => users.id),
    scopes: text('scopes'), // JSON array
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_access_tokens_user').on(table.userId),
    index('idx_access_tokens_expires').on(table.expiresAt),
]);

// OAuth refresh tokens
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
    token: text('token').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: text('user_id').references(() => users.id),
    scopes: text('scopes'), // JSON array
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_refresh_tokens_user').on(table.userId),
]);

// OAuth authorization codes (short-lived, but persist for restarts during auth flow)
export const oauthAuthCodes = pgTable('oauth_auth_codes', {
    code: text('code').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: text('user_id').references(() => users.id),
    codeChallenge: text('code_challenge'),
    redirectUri: text('redirect_uri'),
    scopes: text('scopes'), // JSON array
    resource: text('resource'),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
});

// Observations table - structured learnings from Claude Code sessions
export const observations = pgTable('observations', {
    id: text('id').primaryKey(),
    sessionId: text('session_id'),  // Claude session ID
    userId: text('user_id').references(() => users.id),
    project: text('project'),  // Project name/path
    type: text('type'),  // bugfix, feature, refactor, discovery, decision, change
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    narrative: text('narrative'),
    facts: text('facts'),  // JSON array of fact strings
    concepts: text('concepts'),  // JSON array: how-it-works, problem-solution, pattern, gotcha, trade-off
    filesRead: text('files_read'),  // JSON array of file paths
    filesModified: text('files_modified'),  // JSON array of file paths
    toolName: text('tool_name'),  // Tool that triggered this observation
    toolInput: text('tool_input'),  // Tool input (sanitized)
    discoveryTokens: integer('discovery_tokens'),  // Token cost for ROI tracking
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_observations_session').on(table.sessionId),
    index('idx_observations_user').on(table.userId),
    index('idx_observations_project').on(table.project),
    index('idx_observations_type').on(table.type),
    index('idx_observations_created').on(table.createdAt),
]);

// Session summaries - end-of-session synthesis
export const sessionSummaries = pgTable('session_summaries', {
    id: text('id').primaryKey(),
    sessionId: text('session_id').unique(),  // Claude session ID
    userId: text('user_id').references(() => users.id),
    project: text('project'),
    request: text('request'),  // What user asked for
    investigated: text('investigated'),  // What was looked into
    learned: text('learned'),  // Key insights discovered
    completed: text('completed'),  // What was delivered
    nextSteps: text('next_steps'),  // Recommended follow-ups
    notes: text('notes'),  // Additional context
    filesRead: text('files_read'),  // JSON array
    filesEdited: text('files_edited'),  // JSON array
    discoveryTokens: integer('discovery_tokens'),
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_session_summaries_user').on(table.userId),
    index('idx_session_summaries_project').on(table.project),
    index('idx_session_summaries_created').on(table.createdAt),
]);

// Calq Components - shared registry for agents, skills, commands, output-styles
export const calqComponents = pgTable('calq_components', {
    id: text('id').primaryKey(),
    type: text('type').notNull(),  // 'agent', 'skill', 'command', 'output-style', 'hook'
    name: text('name').notNull(),  // e.g., 'calq-reviewer', 'my-custom-agent'
    description: text('description'),
    content: text('content').notNull(),  // The actual markdown/json/js content
    authorId: text('author_id').references(() => users.id),
    version: text('version').default('1.0.0'),
    isBuiltin: boolean('is_builtin').default(false),  // true for Calq-provided components
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => [
    index('idx_calq_components_type').on(table.type),
    index('idx_calq_components_name').on(table.name),
    index('idx_calq_components_author').on(table.authorId),
]);

import { pgTable, text, integer, boolean, timestamp, real, index } from 'drizzle-orm/pg-core';

// Users table - team members with GitHub OAuth
export const users = pgTable('users', {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email'),
    role: text('role').default('member'),
    githubId: text('github_id'),
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
    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    index('idx_entries_project').on(table.projectId),
    index('idx_entries_user').on(table.userId),
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

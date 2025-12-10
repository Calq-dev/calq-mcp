-- Migration: Add tasks table and YouTrack integration
-- Run with: docker compose exec -T postgres psql -U calq -d calq < migrations/003_tasks.sql

-- Add youtrack_token to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS youtrack_token TEXT;

-- Create tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    user_id TEXT REFERENCES users(id),
    project_id TEXT REFERENCES projects(id),
    youtrack_id TEXT,
    status TEXT DEFAULT 'open',
    synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Create indexes for tasks table
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_youtrack ON tasks(youtrack_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- Add task_id to entries table
ALTER TABLE entries ADD COLUMN IF NOT EXISTS task_id TEXT REFERENCES tasks(id);

-- Create index for task_id on entries
CREATE INDEX IF NOT EXISTS idx_entries_task ON entries(task_id);

-- Observations table - structured learnings from Claude Code sessions
CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    user_id TEXT REFERENCES users(id),
    project TEXT,
    type TEXT,
    title TEXT NOT NULL,
    subtitle TEXT,
    narrative TEXT,
    facts TEXT,
    concepts TEXT,
    files_read TEXT,
    files_modified TEXT,
    tool_name TEXT,
    tool_input TEXT,
    discovery_tokens INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_user ON observations(user_id);
CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);

-- Session summaries - end-of-session synthesis
CREATE TABLE IF NOT EXISTS session_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT UNIQUE,
    user_id TEXT REFERENCES users(id),
    project TEXT,
    request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    notes TEXT,
    files_read TEXT,
    files_edited TEXT,
    discovery_tokens INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_user ON session_summaries(user_id);
CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at);

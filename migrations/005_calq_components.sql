-- Calq Components - shared registry for agents, skills, commands, output-styles
CREATE TABLE IF NOT EXISTS calq_components (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    author_id TEXT REFERENCES users(id),
    version TEXT DEFAULT '1.0.0',
    is_builtin BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calq_components_type ON calq_components(type);
CREATE INDEX IF NOT EXISTS idx_calq_components_name ON calq_components(name);
CREATE INDEX IF NOT EXISTS idx_calq_components_author ON calq_components(author_id);

-- Unique constraint on type + name to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_calq_components_type_name ON calq_components(type, name);

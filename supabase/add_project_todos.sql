-- ==============================================================
-- Table: project_todos (Daily Sub-tasks / To-Dos under Projects)
-- Safe, non-destructive, backwards-compatible
-- ==============================================================

CREATE TABLE IF NOT EXISTS project_todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    todo_date DATE NOT NULL DEFAULT CURRENT_DATE,
    title TEXT NOT NULL,
    is_done BOOLEAN DEFAULT false,
    done_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for instant querying by project & date
CREATE INDEX IF NOT EXISTS idx_project_todos_proj_date ON project_todos(project_id, todo_date);
CREATE INDEX IF NOT EXISTS idx_project_todos_task_date ON project_todos(task_id, todo_date);

-- Active timer tracking: track the active sub-task on the running stopwatch
ALTER TABLE active_timers 
ADD COLUMN IF NOT EXISTS todo_id UUID REFERENCES project_todos(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS todo_title TEXT;

-- Logs tracking: preserve what sub-task was worked on during the session
ALTER TABLE logs 
ADD COLUMN IF NOT EXISTS todo_id UUID REFERENCES project_todos(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS todo_title TEXT;

-- Ensure table is accessible via API keys (matches existing table setup)
ALTER TABLE project_todos DISABLE ROW LEVEL SECURITY;

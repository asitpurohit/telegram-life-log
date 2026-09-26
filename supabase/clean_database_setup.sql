-- ==============================================================
-- CLEAN DATABASE PREPARATION FOR TELEGRAM LIFE-LOG
-- Run this in Supabase Dashboard -> SQL Editor -> New Query -> Run
-- ==============================================================

-- 1. Ensure tasks table has all native columns (including target_days)
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('timer', 'counter', 'tick')),
    reminder_time TIME,
    target_value INTEGER,
    unit TEXT,
    target_days TEXT DEFAULT 'daily',
    is_archived BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure target_days column exists if tasks table was created earlier
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_days TEXT DEFAULT 'daily';

-- 2. Migrate any temporary fallback unit data (e.g. "minutes|weekdays") to native columns
UPDATE tasks 
SET 
  target_days = split_part(unit, '|', 2),
  unit = split_part(unit, '|', 1)
WHERE unit LIKE '%|%';

-- 3. Ensure logs table exists with full native columns
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    task_name TEXT NOT NULL,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    value INTEGER DEFAULT 1,
    notes TEXT,
    mood TEXT,
    summary TEXT,
    projects TEXT[],
    people TEXT[],
    decisions TEXT[],
    focus TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure rich diary columns exist if logs table was created earlier
ALTER TABLE logs 
ADD COLUMN IF NOT EXISTS mood TEXT,
ADD COLUMN IF NOT EXISTS summary TEXT,
ADD COLUMN IF NOT EXISTS projects TEXT[],
ADD COLUMN IF NOT EXISTS people TEXT[],
ADD COLUMN IF NOT EXISTS decisions TEXT[],
ADD COLUMN IF NOT EXISTS focus TEXT;

-- Clean up any temporary session rows from logs
DELETE FROM logs WHERE task_name = '__wizard_session__';

-- 4. Ensure active_timers table exists
CREATE TABLE IF NOT EXISTS active_timers (
    chat_id TEXT PRIMARY KEY,
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    task_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Ensure wizard_sessions table exists for seamless conversation state
CREATE TABLE IF NOT EXISTS wizard_sessions (
    chat_id TEXT PRIMARY KEY,
    step TEXT NOT NULL,
    task_data JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Indexes for lightning fast queries
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_archived);
CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(log_date);
CREATE INDEX IF NOT EXISTS idx_logs_task_name ON logs(task_name);

-- 7. To-Dos table (one-time tasks with an exact date & time)
CREATE TABLE IF NOT EXISTS todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    is_done BOOLEAN DEFAULT false,
    done_at TIMESTAMPTZ,
    reminded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);

-- 8. Ensure direct access permissions (disable RLS blocks)
ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE active_timers DISABLE ROW LEVEL SECURITY;
ALTER TABLE wizard_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE todos DISABLE ROW LEVEL SECURITY;

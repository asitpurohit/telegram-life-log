-- ==============================================================
-- TELEGRAM LIFE-LOG & HABIT TRACKER: SUPABASE DATABASE SCHEMA
-- ==============================================================

-- 1. Tasks Table (Definitions, Timer, Counter, Tick, Reminders)
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,                       -- e.g. "Physics Study", "Drink Water", "Wake Up"
    type TEXT NOT NULL CHECK (type IN ('timer', 'counter', 'tick')),
    reminder_time TIME,                              -- e.g. '08:00:00' or '05:00:00'
    target_value INTEGER,                            -- e.g. 60 (mins) or 5000 (ml)
    unit TEXT,                                       -- 'minutes', 'ml', 'status'
    is_archived BOOLEAN DEFAULT false,                -- Soft-delete (archived tasks hidden from daily use)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Logs Table (History of completed sessions, counts, and diary entries)
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    task_name TEXT NOT NULL,                         -- "Physics Study", "Drink Water", or "Diary"
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    value INTEGER DEFAULT 1,                         -- e.g. 75 (mins), 500 (ml), or 1 (tick)
    notes TEXT,                                      -- Raw diary notes or session reflections
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Active Timers Table (Tracks currently running stopwatch sessions)
CREATE TABLE IF NOT EXISTS active_timers (
    chat_id TEXT PRIMARY KEY,
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    task_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for lightning fast queries
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_archived);
CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(log_date);
CREATE INDEX IF NOT EXISTS idx_logs_task_name ON logs(task_name);

-- Default starter habits (Optional seed)
INSERT INTO tasks (name, type, reminder_time, target_value, unit)
VALUES 
    ('Physics Study', 'timer', '08:00:00', 60, 'minutes'),
    ('Drink Water', 'counter', NULL, 5000, 'ml'),
    ('Wake Up', 'tick', '05:00:00', 1, 'status')
ON CONFLICT (name) DO NOTHING;

-- Ensure tables are accessible via API keys
ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE active_timers DISABLE ROW LEVEL SECURITY;

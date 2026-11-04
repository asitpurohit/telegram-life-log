-- ==============================================================
-- Migration: Add Pomodoro Settings & Active State
-- Safe, non-destructive, backwards-compatible
-- ==============================================================

-- 1. Tasks table: Pomodoro configuration per task
ALTER TABLE tasks 
ADD COLUMN IF NOT EXISTS is_pomodoro BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS pomodoro_work_mins INTEGER DEFAULT 25,
ADD COLUMN IF NOT EXISTS pomodoro_break_mins INTEGER DEFAULT 5;

-- 2. Active Timers table: Runtime tracking for live Pomodoro rounds & phases
ALTER TABLE active_timers
ADD COLUMN IF NOT EXISTS is_pomodoro BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS pomodoro_work_mins INTEGER DEFAULT 25,
ADD COLUMN IF NOT EXISTS pomodoro_break_mins INTEGER DEFAULT 5,
ADD COLUMN IF NOT EXISTS pomodoro_round INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS pomodoro_phase TEXT DEFAULT 'work',
ADD COLUMN IF NOT EXISTS phase_started_at TIMESTAMPTZ DEFAULT NOW();

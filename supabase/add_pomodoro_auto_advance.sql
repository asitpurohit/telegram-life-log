-- ==============================================================
-- Migration: Add Pomodoro Auto-Advance (10-second auto phase pass)
-- Safe, non-destructive, backwards-compatible
-- ==============================================================

-- 1. Tasks table: Persist auto-advance preference per task
ALTER TABLE tasks 
ADD COLUMN IF NOT EXISTS pomodoro_auto_advance BOOLEAN DEFAULT false;

-- 2. Active Timers table: Runtime tracking for live session
ALTER TABLE active_timers
ADD COLUMN IF NOT EXISTS pomodoro_auto_advance BOOLEAN DEFAULT false;

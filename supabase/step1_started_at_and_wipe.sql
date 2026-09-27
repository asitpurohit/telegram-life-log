-- ==============================================================
-- STEP 1 MIGRATION: logs.started_at + wipe existing logs
-- Run this in Supabase Dashboard -> SQL Editor -> New Query -> Run
-- ==============================================================

-- 1. Add machine-readable session start (nullable; only timer sessions set it)
ALTER TABLE logs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- 2. Wipe all existing log entries (fresh start; no backfill needed).
--    Only the logs table is touched: tasks / wizard_sessions / active_timers stay intact.
DELETE FROM logs;

-- 3. Make the new column visible to the REST API immediately
NOTIFY pgrst, 'reload schema';

-- 4. Verify: expected columns present, zero logs remaining
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'logs'
  AND column_name IN ('started_at', 'created_at', 'log_date', 'value')
ORDER BY column_name;

SELECT COUNT(*) AS logs_remaining FROM logs;

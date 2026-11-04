-- ==============================================================
-- Migration: Add User Settings & Idle Guardian Configuration
-- ==============================================================

CREATE TABLE IF NOT EXISTS user_settings (
    chat_id TEXT PRIMARY KEY,
    idle_nudge_enabled BOOLEAN DEFAULT false,
    idle_window_start TEXT DEFAULT '05:00',
    idle_window_end TEXT DEFAULT '22:00',
    idle_interval_mins INTEGER DEFAULT 3,
    idle_snoozed_until TIMESTAMPTZ,
    last_idle_nudge_at TIMESTAMPTZ,
    summary_email_to TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent column addition if table already exists
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS summary_email_to TEXT;

-- Ensure table is accessible via Supabase API keys
ALTER TABLE user_settings DISABLE ROW LEVEL SECURITY;

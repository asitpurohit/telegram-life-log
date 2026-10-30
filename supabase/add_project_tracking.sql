-- ==============================================================
-- Migration: Add Project Tracking for Timer Tasks
-- Safe, non-destructive, backwards-compatible
-- ==============================================================

-- 1. Add is_project_based flag to tasks table (defaults to false for all existing tasks)
ALTER TABLE tasks 
ADD COLUMN IF NOT EXISTS is_project_based BOOLEAN DEFAULT false;

-- 2. Create projects table to track multi-session projects
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_projects_task_status ON projects(task_id, status);

-- 3. Add project tracking columns to active_timers (stores active session's project)
ALTER TABLE active_timers 
ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS project_name TEXT;

-- 4. Add project_id to logs table (links time session to the project)
ALTER TABLE logs 
ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_logs_project_id ON logs(project_id);

-- 5. Ensure RLS is disabled on projects (matches existing project setup)
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;

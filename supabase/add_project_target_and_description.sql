-- ==============================================================
-- Migration: Add Target Hours & Description to Projects
-- Safe, non-destructive, backwards-compatible
-- ==============================================================

ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS target_minutes INTEGER,
ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE tasks ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tasks ADD COLUMN schedule_occurrence_id TEXT;

CREATE TABLE schedule_definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK(mode IN ('report', 'discover', 'auto_execute')),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('once', 'interval')),
  timezone TEXT NOT NULL,
  start_at TEXT NOT NULL,
  interval_value INTEGER,
  interval_unit TEXT CHECK(interval_unit IN ('hour', 'day', 'week')),
  missed_policy TEXT NOT NULL CHECK(missed_policy IN ('catch_up_once', 'skip')),
  overlap_policy TEXT NOT NULL DEFAULT 'coalesce' CHECK(overlap_policy IN ('coalesce', 'skip')),
  automation_boundary_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  next_run_at TEXT,
  last_triggered_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_schedule_definitions_due
  ON schedule_definitions(enabled, next_run_at);
CREATE INDEX idx_schedule_definitions_project
  ON schedule_definitions(project_id, updated_at DESC);

CREATE TABLE schedule_occurrences (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
  planned_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'skipped', 'completed', 'failed', 'awaiting_confirmation')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(schedule_id, planned_at)
);

CREATE INDEX idx_schedule_occurrences_schedule
  ON schedule_occurrences(schedule_id, planned_at DESC);

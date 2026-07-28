CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES task_steps(id),
  skill_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_session_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(task_id, artifact_type, version)
);

CREATE INDEX IF NOT EXISTS artifact_versions_by_task
  ON artifact_versions(task_id, created_at);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES task_steps(id),
  attempt INTEGER NOT NULL,
  manifest_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, step_id, attempt)
);

CREATE TABLE IF NOT EXISTS task_permission_grants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, permission, patterns_json)
);

CREATE TABLE IF NOT EXISTS change_manifests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES task_steps(id),
  attempt INTEGER NOT NULL,
  directory_id TEXT NOT NULL REFERENCES project_directories(id),
  base_commit TEXT NOT NULL,
  checkpoint_commit TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  has_out_of_scope_changes INTEGER NOT NULL DEFAULT 0,
  has_sensitive_changes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, step_id, attempt, directory_id)
);

CREATE TABLE IF NOT EXISTS gate_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  directory_id TEXT NOT NULL REFERENCES project_directories(id),
  command_argv_json TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL DEFAULT 0,
  log_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(task_id, gate_id, attempt)
);

ALTER TABLE tasks ADD COLUMN auto_replan_count INTEGER NOT NULL DEFAULT 0;

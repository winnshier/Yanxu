CREATE TABLE IF NOT EXISTS task_workspaces (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  directory_id TEXT NOT NULL REFERENCES project_directories(id),
  workspace_path TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  task_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_id, directory_id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES task_steps(id),
  agent_id TEXT REFERENCES agent_profiles(id),
  executor TEXT NOT NULL,
  model TEXT NOT NULL,
  external_session_id TEXT,
  status TEXT NOT NULL,
  result_path TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  external_request_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  previous_task_status TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(session_id, external_request_id)
);

CREATE TABLE IF NOT EXISTS gate_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate_id TEXT NOT NULL,
  directory_id TEXT NOT NULL REFERENCES project_directories(id),
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  log_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(task_id, gate_id)
);

CREATE TABLE IF NOT EXISTS delivery_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

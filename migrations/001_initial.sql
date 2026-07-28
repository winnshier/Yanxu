CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_space_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_directories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  selected_path TEXT NOT NULL,
  real_path TEXT NOT NULL,
  git_root_path TEXT,
  git_initialized INTEGER NOT NULL DEFAULT 0,
  current_branch TEXT,
  is_dirty INTEGER NOT NULL DEFAULT 0,
  content_types_json TEXT NOT NULL DEFAULT '[]',
  stack_json TEXT NOT NULL DEFAULT '[]',
  commands_json TEXT NOT NULL DEFAULT '{}',
  scanned_at TEXT NOT NULL,
  UNIQUE(project_id, real_path)
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  executor TEXT NOT NULL,
  model TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  permission_mode TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_default_team ON teams(is_default) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(team_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  expected_output TEXT NOT NULL DEFAULT '',
  constraints_text TEXT NOT NULL DEFAULT '',
  forbidden_paths_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  active_step_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, version)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE(task_id, version)
);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  skill_id TEXT NOT NULL,
  agent_id TEXT REFERENCES agent_profiles(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  summary TEXT,
  UNIQUE(task_id, position)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available_at, priority DESC);

CREATE TABLE IF NOT EXISTS workflow_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_aggregate ON workflow_events(aggregate_type, aggregate_id, seq DESC);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  source_task_id TEXT REFERENCES tasks(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  entity_id UNINDEXED,
  project_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);

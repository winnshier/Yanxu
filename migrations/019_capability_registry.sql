ALTER TABLE task_steps ADD COLUMN capability_ids_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  origin_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'mcp')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  source_executor TEXT,
  source_ref TEXT NOT NULL,
  source_version TEXT,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  compatibility_json TEXT NOT NULL DEFAULT '[]',
  lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('discovered', 'imported', 'installed')),
  parse_status TEXT NOT NULL CHECK(parse_status IN ('valid', 'invalid')),
  parse_error TEXT,
  command_status TEXT NOT NULL CHECK(command_status IN ('not_applicable', 'available', 'missing', 'unchecked')),
  runtime_health TEXT NOT NULL CHECK(runtime_health IN ('not_applicable', 'unchecked', 'healthy', 'unhealthy', 'needs_auth')),
  credential_refs_json TEXT NOT NULL DEFAULT '[]',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  managed_path TEXT,
  security_json TEXT NOT NULL DEFAULT '{}',
  last_discovered_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX capabilities_by_kind_status ON capabilities(kind, lifecycle_status, updated_at DESC);
CREATE INDEX capabilities_by_executor ON capabilities(source_executor, updated_at DESC);

CREATE TABLE project_capabilities (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1,
  locked_version TEXT NOT NULL,
  locked_hash TEXT NOT NULL,
  configuration_json TEXT NOT NULL DEFAULT '{}',
  enabled_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, capability_id)
);

CREATE INDEX project_capabilities_by_project ON project_capabilities(project_id, enabled, updated_at DESC);

CREATE TABLE project_capability_locks (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_capability_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'mcp')),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  executor TEXT NOT NULL,
  configuration_json TEXT NOT NULL DEFAULT '{}',
  projection_path TEXT,
  status TEXT NOT NULL CHECK(status IN ('frozen', 'projected', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, step_id, capability_id)
);

CREATE INDEX task_capabilities_by_task ON task_capability_snapshots(task_id, step_id, created_at);

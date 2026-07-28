ALTER TABLE knowledge_items ADD COLUMN supersedes_id TEXT REFERENCES knowledge_items(id);

CREATE TABLE IF NOT EXISTS project_space_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  commit_hash TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_space_operations_by_project
  ON project_space_operations(project_id, created_at);

CREATE TABLE IF NOT EXISTS directory_profiles (
  id TEXT PRIMARY KEY,
  directory_id TEXT NOT NULL REFERENCES project_directories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_json TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE(directory_id, version)
);

CREATE INDEX IF NOT EXISTS directory_profiles_by_directory
  ON directory_profiles(directory_id, version DESC);

CREATE TABLE IF NOT EXISTS recovery_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  job_id TEXT,
  reason TEXT NOT NULL,
  previous_owner TEXT,
  recovered_by TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS recovery_records_by_task
  ON recovery_records(task_id, created_at);

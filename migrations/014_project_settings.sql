CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  permission_mode TEXT NOT NULL DEFAULT 'inherit',
  forbidden_paths_json TEXT NOT NULL DEFAULT '[]',
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

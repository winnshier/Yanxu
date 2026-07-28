ALTER TABLE project_directories ADD COLUMN removed_at TEXT;

CREATE INDEX IF NOT EXISTS project_directories_active
  ON project_directories(project_id, removed_at, scanned_at);

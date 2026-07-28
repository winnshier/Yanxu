CREATE TABLE IF NOT EXISTS delivery_conflicts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  directory_id TEXT NOT NULL,
  task_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  classification TEXT NOT NULL,
  conflicts_json TEXT NOT NULL,
  mechanically_resolvable_files_json TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS delivery_conflicts_by_task
  ON delivery_conflicts(task_id, status, created_at);

CREATE TABLE IF NOT EXISTS run_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  plan_version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, plan_id)
);

CREATE INDEX IF NOT EXISTS run_snapshots_by_task ON run_snapshots(task_id, created_at DESC);

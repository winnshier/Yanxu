CREATE TABLE IF NOT EXISTS preapproval_artifact_versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_executor TEXT NOT NULL,
  source_model TEXT NOT NULL,
  source_session_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, artifact_type, version)
);

CREATE INDEX IF NOT EXISTS preapproval_artifacts_by_task
  ON preapproval_artifact_versions(task_id, created_at);

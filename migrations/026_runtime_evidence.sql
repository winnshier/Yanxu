ALTER TABLE execution_runs ADD COLUMN executor TEXT;
ALTER TABLE execution_runs ADD COLUMN model TEXT;
ALTER TABLE execution_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE execution_runs ADD COLUMN workspaces_json TEXT NOT NULL DEFAULT '[]';

UPDATE execution_runs
SET executor = (SELECT executor FROM agent_sessions WHERE agent_sessions.id = execution_runs.id),
    model = (SELECT model FROM agent_sessions WHERE agent_sessions.id = execution_runs.id)
WHERE executor IS NULL OR model IS NULL;

ALTER TABLE task_capability_snapshots ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'not_checked';
ALTER TABLE task_capability_snapshots ADD COLUMN runtime_detail_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE task_capability_snapshots ADD COLUMN runtime_checked_at TEXT;
ALTER TABLE task_capability_snapshots ADD COLUMN last_run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL;

CREATE INDEX task_capabilities_by_runtime_status
  ON task_capability_snapshots(task_id, runtime_status, runtime_checked_at);

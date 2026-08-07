ALTER TABLE tasks ADD COLUMN flow_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE task_steps ADD COLUMN unit_kind TEXT NOT NULL DEFAULT 'legacy_skill';
ALTER TABLE task_steps ADD COLUMN required_capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task_steps ADD COLUMN verification_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task_steps ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'read_only';
ALTER TABLE task_steps ADD COLUMN requires_independent_session INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_by_flow_version ON tasks(flow_version, updated_at DESC);

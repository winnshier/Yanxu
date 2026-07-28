CREATE TABLE IF NOT EXISTS task_designed_gates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_step_id TEXT NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  command_argv_json TEXT NOT NULL,
  directory_id TEXT NOT NULL REFERENCES project_directories(id) ON DELETE CASCADE,
  required INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL,
  expected_exit_codes_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_designed_gates_by_task
  ON task_designed_gates(task_id, source_step_id, created_at);

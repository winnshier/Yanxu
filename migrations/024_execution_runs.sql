CREATE TABLE executor_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
  executor TEXT NOT NULL,
  model TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  UNIQUE(task_id, agent_id, executor, external_session_id)
);

CREATE INDEX idx_executor_sessions_task_agent
  ON executor_sessions(task_id, agent_id, status, last_used_at DESC);

CREATE TABLE execution_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
  executor_session_id TEXT REFERENCES executor_sessions(id) ON DELETE SET NULL,
  retry_of_run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
  trigger_source TEXT NOT NULL DEFAULT 'manual' CHECK(trigger_source IN ('manual', 'schedule', 'recovery', 'external_event')),
  status TEXT NOT NULL CHECK(status IN ('preparing', 'running', 'succeeded', 'failed', 'interrupted', 'stopped')),
  phase TEXT NOT NULL DEFAULT 'preparing',
  failure_category TEXT,
  failure_code TEXT,
  failure_message TEXT,
  next_action TEXT,
  workspace_reused INTEGER NOT NULL DEFAULT 0 CHECK(workspace_reused IN (0, 1)),
  session_reused INTEGER NOT NULL DEFAULT 0 CHECK(session_reused IN (0, 1)),
  runtime_directory TEXT,
  log_path TEXT,
  result_path TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_execution_runs_task_started
  ON execution_runs(task_id, started_at DESC);
CREATE INDEX idx_execution_runs_job
  ON execution_runs(job_id, status);
CREATE INDEX idx_execution_runs_retry
  ON execution_runs(retry_of_run_id);

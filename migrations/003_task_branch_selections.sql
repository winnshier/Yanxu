CREATE TABLE IF NOT EXISTS task_branch_selections (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  directory_id TEXT NOT NULL REFERENCES project_directories(id),
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  PRIMARY KEY(task_id, directory_id)
);

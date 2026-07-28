CREATE TABLE IF NOT EXISTS executor_validations (
  executor TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  models_json TEXT NOT NULL DEFAULT '[]',
  login_status TEXT NOT NULL DEFAULT 'unknown',
  checked_at TEXT NOT NULL
);

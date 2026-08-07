CREATE TABLE migration_recovery_points (
  id TEXT PRIMARY KEY,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  backup_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('created', 'restored')) DEFAULT 'created',
  created_at TEXT NOT NULL,
  restored_at TEXT
);

CREATE INDEX idx_migration_recovery_points_created
  ON migration_recovery_points(created_at DESC);

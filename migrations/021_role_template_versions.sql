CREATE TABLE role_template_versions (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES role_templates(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  managed_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(role_id, content_hash)
);

CREATE INDEX role_template_versions_by_role ON role_template_versions(role_id, created_at DESC);

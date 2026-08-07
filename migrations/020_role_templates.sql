CREATE TABLE role_templates (
  id TEXT PRIMARY KEY,
  origin_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  responsibilities_json TEXT NOT NULL DEFAULT '[]',
  capability_ids_json TEXT NOT NULL DEFAULT '[]',
  dependency_names_json TEXT NOT NULL DEFAULT '[]',
  default_permissions_json TEXT NOT NULL DEFAULT '[]',
  compatibility_json TEXT NOT NULL DEFAULT '[]',
  source_type TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  source_executor TEXT,
  source_ref TEXT NOT NULL,
  source_version TEXT,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('draft', 'installed')),
  parse_status TEXT NOT NULL CHECK(parse_status IN ('valid', 'incompatible', 'view_only')),
  parse_error TEXT,
  format TEXT NOT NULL,
  managed_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX role_templates_by_status ON role_templates(lifecycle_status, parse_status, updated_at DESC);
CREATE INDEX role_templates_by_source ON role_templates(source_type, source_ref);

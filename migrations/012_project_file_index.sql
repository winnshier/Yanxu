CREATE TABLE IF NOT EXISTS project_file_index (
  directory_id TEXT NOT NULL REFERENCES project_directories(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at_ms REAL NOT NULL,
  sample TEXT NOT NULL,
  sample_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY(directory_id, relative_path)
);

CREATE INDEX IF NOT EXISTS project_file_index_by_directory
  ON project_file_index(directory_id, relative_path);

CREATE VIRTUAL TABLE IF NOT EXISTS project_file_fts USING fts5(
  directory_id UNINDEXED,
  relative_path,
  sample,
  tokenize = 'unicode61'
);

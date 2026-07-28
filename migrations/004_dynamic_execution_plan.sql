ALTER TABLE task_steps ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task_steps ADD COLUMN directory_ids_json TEXT NOT NULL DEFAULT '[]';

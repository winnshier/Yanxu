ALTER TABLE agent_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active', 'inactive'));

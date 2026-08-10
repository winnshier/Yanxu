DROP INDEX IF EXISTS tasks_by_flow_version;

DELETE FROM jobs WHERE type = 'RUN_SKILL_STEP';

ALTER TABLE task_steps RENAME COLUMN skill_id TO unit_key;
ALTER TABLE artifact_versions RENAME COLUMN skill_id TO unit_key;

ALTER TABLE task_steps DROP COLUMN unit_kind;
ALTER TABLE tasks DROP COLUMN flow_version;

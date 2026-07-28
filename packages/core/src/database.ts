import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export type SqliteDatabase = Database.Database;

export function openDatabase(databasePath: string): SqliteDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  applyMigrations(database);
  return database;
}

function applyMigrations(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrations = [
    { version: 1, file: '001_initial.sql' },
    { version: 2, file: '002_execution.sql' },
    { version: 3, file: '003_task_branch_selections.sql' },
    { version: 4, file: '004_dynamic_execution_plan.sql' },
    { version: 5, file: '005_run_snapshots.sql' },
    { version: 6, file: '006_core_execution_evidence.sql' },
    { version: 7, file: '007_preapproval_artifacts.sql' },
    { version: 8, file: '008_task_designed_gates.sql' },
    { version: 9, file: '009_delivery_conflicts.sql' },
    { version: 10, file: '010_project_memory_and_recovery.sql' },
    { version: 11, file: '011_delivery_actions.sql' },
    { version: 12, file: '012_project_file_index.sql' },
    { version: 13, file: '013_soft_remove_project_directories.sql' },
    { version: 14, file: '014_project_settings.sql' },
    { version: 15, file: '015_agent_status.sql' },
    { version: 16, file: '016_executor_validations.sql' },
    { version: 17, file: '017_task_attachments.sql' },
  ];
  const appliedStatement = database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordStatement = database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  for (const migration of migrations) {
    if (appliedStatement.get(migration.version)) continue;
    const sql = readFileSync(resolve(moduleDirectory, '../../../migrations', migration.file), 'utf8');
    database.transaction(() => {
      database.exec(sql);
      recordStatement.run(migration.version, new Date().toISOString());
    })();
  }
}

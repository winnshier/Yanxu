import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export type SqliteDatabase = Database.Database;

export interface DatabaseMigrationRecoveryPoint {
  id: string;
  fromVersion: number;
  toVersion: number;
  backupPath: string;
  status: 'created' | 'restored';
  createdAt: string;
  restoredAt: string | null;
}

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
  { version: 18, file: '018_work_units.sql' },
  { version: 19, file: '019_capability_registry.sql' },
  { version: 20, file: '020_role_templates.sql' },
  { version: 21, file: '021_role_template_versions.sql' },
  { version: 22, file: '022_agent_default_capabilities.sql' },
  { version: 23, file: '023_migration_recovery_points.sql' },
  { version: 24, file: '024_execution_runs.sql' },
] as const;

export const DATABASE_SCHEMA_VERSION = migrations.at(-1)!.version;

export function openDatabase(databasePath: string): SqliteDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('synchronous = NORMAL');
    database.pragma('busy_timeout = 5000');
    applyMigrations(database, databasePath);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function applyMigrations(database: SqliteDatabase, databasePath: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedStatement = database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordStatement = database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  const appliedVersions = new Set(
    (database.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version),
  );
  const pendingMigrations = migrations.filter((migration) => !appliedVersions.has(migration.version));
  const currentVersion = Math.max(0, ...appliedVersions);
  if (currentVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Yanxu database schema v${currentVersion} is newer than this application supports (v${DATABASE_SCHEMA_VERSION}). Upgrade Yanxu instead of opening it with an older build.`,
    );
  }
  for (let version = 1; version <= currentVersion; version += 1) {
    if (!appliedVersions.has(version)) {
      throw new Error(`Yanxu database migration history is incomplete: schema v${version} is missing before v${currentVersion}.`);
    }
  }
  const recoveryPoint = currentVersion > 0 && pendingMigrations.length > 0
    ? createMigrationRecoveryPoint(database, databasePath, currentVersion, pendingMigrations.at(-1)!.version)
    : null;
  for (const migration of pendingMigrations) {
    const sql = readFileSync(resolve(moduleDirectory, '../../../migrations', migration.file), 'utf8');
    database.transaction(() => {
      database.exec(sql);
      recordStatement.run(migration.version, new Date().toISOString());
    })();
  }
  if (recoveryPoint) {
    database.prepare(`
      INSERT INTO migration_recovery_points(id, from_version, to_version, backup_path, status, created_at)
      VALUES (?, ?, ?, ?, 'created', ?)
    `).run(recoveryPoint.id, recoveryPoint.fromVersion, recoveryPoint.toVersion,
      recoveryPoint.backupPath, recoveryPoint.createdAt);
  }
}

function createMigrationRecoveryPoint(
  database: SqliteDatabase,
  databasePath: string,
  fromVersion: number,
  toVersion: number,
): DatabaseMigrationRecoveryPoint {
  const createdAt = new Date().toISOString();
  const id = `migration-v${fromVersion}-to-v${toVersion}-${createdAt.replace(/[^0-9]/g, '')}-${process.pid}`;
  const backupDirectory = join(dirname(databasePath), 'migration-backups');
  mkdirSync(backupDirectory, { recursive: true });
  const backupPath = join(backupDirectory, `${id}.db`);
  if (existsSync(backupPath)) throw new Error(`Migration recovery point already exists: ${backupPath}`);
  database.pragma('wal_checkpoint(FULL)');
  database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  const verification = new Database(backupPath, { readonly: true });
  try {
    const quickCheck = verification.pragma('quick_check') as Array<{ quick_check: string }>;
    if (!quickCheck.every((row) => row.quick_check === 'ok')) {
      throw new Error(`Migration recovery point failed SQLite quick_check: ${basename(backupPath)}`);
    }
  } finally {
    verification.close();
  }
  return { id, fromVersion, toVersion, backupPath, status: 'created', createdAt, restoredAt: null };
}

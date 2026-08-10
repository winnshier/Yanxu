import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DATABASE_SCHEMA_VERSION, openDatabase } from './database.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('database migration recovery', () => {
  it('creates and verifies a rollback database before upgrading an existing schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-migration-'));
    roots.push(root);
    const databasePath = join(root, 'system', 'app.db');
    mkdirSync(join(root, 'system'));
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE legacy_marker (value TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE execution_runs (id TEXT PRIMARY KEY);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, executor TEXT, model TEXT);
      CREATE TABLE task_capability_snapshots (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
      CREATE TABLE migration_recovery_points (
        id TEXT PRIMARY KEY,
        from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL,
        backup_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored_at TEXT
      );
      INSERT INTO legacy_marker(value) VALUES ('before-upgrade');
    `);
    const insert = legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
    for (let version = 1; version < DATABASE_SCHEMA_VERSION; version += 1) {
      insert.run(version, new Date().toISOString());
    }
    legacy.close();

    const upgraded = openDatabase(databasePath);
    const schemaVersion = (upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
    const recovery = upgraded.prepare('SELECT * FROM migration_recovery_points').get() as {
      from_version: number; to_version: number; backup_path: string; status: string;
    };
    expect(schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    expect(recovery).toMatchObject({
      from_version: DATABASE_SCHEMA_VERSION - 1,
      to_version: DATABASE_SCHEMA_VERSION,
      status: 'created',
    });
    expect(existsSync(recovery.backup_path)).toBe(true);
    upgraded.close();

    const rollback = new Database(recovery.backup_path, { readonly: true });
    expect(rollback.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    expect((rollback.prepare('SELECT value FROM legacy_marker').get() as { value: string }).value).toBe('before-upgrade');
    expect(rollback.prepare("SELECT name FROM sqlite_master WHERE name = 'migration_recovery_points'").get()).toBeDefined();
    rollback.close();

    const recoveryScript = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/database-recovery.mjs');
    const restored = spawnSync(process.execPath, [recoveryScript, 'restore', root, recovery.backup_path], { encoding: 'utf8' });
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain('Previous database preserved');
    const restoredDatabase = new Database(databasePath, { readonly: true });
    expect((restoredDatabase.prepare('SELECT value FROM legacy_marker').get() as { value: string }).value).toBe('before-upgrade');
    expect(restoredDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'migration_recovery_points'").get()).toBeDefined();
    restoredDatabase.close();
    expect(readdirSync(join(root, 'system', 'migration-backups'))
      .some((name) => name.startsWith('before-manual-restore-'))).toBe(true);
  });

  it('refuses to open a database created by a newer Yanxu schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-future-schema-'));
    roots.push(root);
    const databasePath = join(root, 'system', 'app.db');
    mkdirSync(join(root, 'system'));
    const future = new Database(databasePath);
    future.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    future.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(DATABASE_SCHEMA_VERSION + 1, new Date().toISOString());
    future.close();
    expect(() => openDatabase(databasePath)).toThrow('newer than this application supports');
  });
});

import { createRequire } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const Database = requireFromCore('better-sqlite3');
const [operation, homeArgument, backupArgument] = process.argv.slice(2);
const workbenchHome = resolve(homeArgument ?? '');
const systemDirectory = join(workbenchHome, 'system');
const backupDirectory = join(systemDirectory, 'migration-backups');
const databasePath = join(systemDirectory, 'app.db');
mkdirSync(backupDirectory, { recursive: true });

if (operation === 'list') {
  const backups = readdirSync(backupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (backups.length === 0) process.stdout.write('[yanxu] No database migration recovery points found.\n');
  else process.stdout.write(`${backups.join('\n')}\n`);
  process.exit(0);
}

if (operation !== 'restore' || !backupArgument) {
  throw new Error('Usage: database-recovery.mjs list <YANXU_HOME> | restore <YANXU_HOME> <backup>');
}
if (!existsSync(databasePath)) throw new Error(`Yanxu database does not exist: ${databasePath}`);

const backupCandidate = resolve(backupDirectory, backupArgument);
const resolvedBackupDirectory = realpathSync(backupDirectory);
const resolvedBackup = realpathSync(backupCandidate);
if (dirname(resolvedBackup) !== resolvedBackupDirectory) {
  throw new Error('Only a recovery point listed by ./yanxu db-backups can be restored.');
}
verifyDatabase(resolvedBackup);

const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
const safetyPath = join(backupDirectory, `before-manual-restore-${timestamp}-${process.pid}.db`);
const current = new Database(databasePath);
try {
  verifyOpenDatabase(current, databasePath);
  current.pragma('wal_checkpoint(FULL)');
  current.exec(`VACUUM INTO '${safetyPath.replaceAll("'", "''")}'`);
} finally {
  current.close();
}

const temporaryPath = join(systemDirectory, `.app.db.restore-${process.pid}`);
copyFileSync(resolvedBackup, temporaryPath);
chmodSync(temporaryPath, 0o600);
try {
  verifyDatabase(temporaryPath);
  renameSync(temporaryPath, databasePath);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
} catch (error) {
  rmSync(temporaryPath, { force: true });
  throw error;
}

process.stdout.write(`[yanxu] Restored ${basename(resolvedBackup)}.\n`);
process.stdout.write(`[yanxu] Previous database preserved at ${safetyPath}.\n`);
process.stdout.write('[yanxu] Run ./yanxu to apply current migrations and start safely.\n');

function verifyDatabase(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    verifyOpenDatabase(database, path);
  } finally {
    database.close();
  }
}

function verifyOpenDatabase(database, path) {
  const result = database.pragma('quick_check');
  if (!result.every((row) => row.quick_check === 'ok')) {
    throw new Error(`SQLite quick_check failed for ${path}.`);
  }
}

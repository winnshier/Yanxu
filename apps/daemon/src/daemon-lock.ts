import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DaemonLock {
  path: string;
  release: () => void;
}

export function acquireDaemonLock(workbenchHome: string): DaemonLock {
  const systemDirectory = join(workbenchHome, 'system');
  mkdirSync(systemDirectory, { recursive: true });
  const path = join(systemDirectory, 'daemon.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
      closeSync(descriptor);
      return {
        path,
        release: () => {
          try {
            const current = JSON.parse(readFileSync(path, 'utf8')) as { token?: string };
            if (current.token === token) unlinkSync(path);
          } catch {
            // A missing or replaced lock no longer belongs to this process.
          }
        },
      };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const owner = readLockOwner(path);
      if (owner?.pid && processIsAlive(owner.pid)) {
        throw new Error(`Yanxu daemon is already running with PID ${owner.pid}.`);
      }
      unlinkSync(path);
    }
  }
  throw new Error('Unable to acquire the Yanxu daemon lock.');
}

function readLockOwner(path: string): { pid?: number } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

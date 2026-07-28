import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDaemonLock } from './daemon-lock.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('daemon lock', () => {
  it('prevents two local daemon instances and releases only its own lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-daemon-lock-'));
    roots.push(root);
    const first = acquireDaemonLock(root);
    expect(() => acquireDaemonLock(root)).toThrow('already running');
    first.release();
    const second = acquireDaemonLock(root);
    expect(second.path).toBe(first.path);
    second.release();
  });
});

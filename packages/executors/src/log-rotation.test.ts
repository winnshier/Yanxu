import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateLogFile } from './log-rotation.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime log rotation', () => {
  it('keeps bounded generations without overwriting the newest evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-log-'));
    roots.push(root);
    const path = join(root, 'runtime.log');
    writeFileSync(path, 'first-run');
    expect(rotateLogFile(path, 4, 2)).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('first-run');
    writeFileSync(path, 'second-run');
    expect(rotateLogFile(path, 4, 2)).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('second-run');
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('first-run');
  });
});

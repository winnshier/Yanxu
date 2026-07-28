import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { scanProjectDirectory } from './directory-scanner.js';

const temporaryDirectories: string[] = [];

function git(repository: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('scanProjectDirectory', () => {
  it('does not initialize Git during project discovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yanxu-scan-only-test-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'notes.md'), '# Notes\n');

    const result = scanProjectDirectory({ id: 'dir_test', projectId: 'prj_test', selectedPath: directory, initializeGit: false });

    expect(result.gitInitialized).toBe(false);
    expect(result.gitRootPath).toBeNull();
  });

  it('initializes an unborn directory with a local baseline branch while excluding secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yanxu-scan-test-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'README.md'), '# New project\n');
    writeFileSync(join(directory, '.env'), 'TOKEN=secret\n');

    const result = scanProjectDirectory({ id: 'dir_test', projectId: 'prj_test', selectedPath: directory, initializeGit: true });

    expect(result.gitInitialized).toBe(true);
    expect(result.currentBranch).toBeTruthy();
    expect(result.localBranches).toContain(result.currentBranch);
    expect(git(directory, 'show', 'HEAD:README.md')).toContain('New project');
    expect(spawnSync('git', ['-C', directory, 'show', 'HEAD:.env'], { encoding: 'utf8' }).status).not.toBe(0);
  });

  it('discovers language-appropriate quality commands', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yanxu-stack-test-'));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, 'tests'));
    writeFileSync(join(directory, 'pyproject.toml'), '[tool.pytest.ini_options]\n[tool.ruff]\n');

    const result = scanProjectDirectory({ id: 'dir_test', projectId: 'prj_test', selectedPath: directory, initializeGit: true });

    expect(result.stack).toContain('python');
    expect(result.commands.test).toBe('python -m pytest');
    expect(result.commands.lint).toBe('python -m ruff check .');
  });
});

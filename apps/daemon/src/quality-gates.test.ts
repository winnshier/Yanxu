import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QualityGate } from '@yanxu/contracts';
import type { PreparedWorkspace } from '@yanxu/core';
import { parseCommandArgv, runQualityGates } from './quality-gates.js';

describe('quality gate argv parsing', () => {
  it('preserves quoted arguments without invoking a shell', () => {
    expect(parseCommandArgv('pnpm test -- --testNamePattern "critical flow"')).toEqual([
      'pnpm',
      'test',
      '--',
      '--testNamePattern',
      'critical flow',
    ]);
  });

  it('rejects shell composition operators', () => {
    expect(() => parseCommandArgv('pnpm test | tee result.log')).toThrow('executable argv');
    expect(() => parseCommandArgv('echo $(whoami)')).toThrow('executable argv');
  });

  it('terminates a running gate when the task is paused or stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-gate-abort-'));
    const gate: QualityGate = {
      id: 'gate_abort',
      name: 'long-running',
      command: `${process.execPath} -e setInterval(()=>{},1000)`,
      commandArgv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      directoryId: 'dir_a',
      required: true,
      status: 'pending',
    };
    const workspace: PreparedWorkspace = {
      taskId: 'task_abort',
      directoryId: 'dir_a',
      workspacePath: root,
      scopePath: root,
      baselineCommit: 'UNBORN',
      taskBranch: 'yanxu/task-abort',
      targetBranch: 'main',
    };
    const controller = new AbortController();
    const running = runQualityGates('task_abort', [gate], [workspace], root, 1, controller.signal);
    setTimeout(() => controller.abort(), 50);

    const [result] = await running;
    if (!result) throw new Error('Expected the aborted gate to return a result.');
    expect(result).toMatchObject({ status: 'failed', exitCode: 130, timedOut: false });
    expect(readFileSync(result.logPath, 'utf8')).toContain('aborted by task control');
  });
});

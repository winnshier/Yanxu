import { describe, expect, it } from 'vitest';
import type { TaskPlan } from '@yanxu/contracts';
import { commandPatternsForPlanPermissions } from './plan-permissions.js';

function plan(
  permissions: string[],
  commandArgv: string[] = ['npm', '--prefix', 'yanxu-h5', 'run', 'test'],
): Pick<TaskPlan, 'permissions' | 'qualityGates'> {
  return {
    permissions,
    qualityGates: [{
      id: 'gate-test',
      name: 'test',
      command: commandArgv.join(' '),
      commandArgv,
      source: 'task_specific',
      directoryId: 'dir-a',
      required: true,
      timeoutMs: 30_000,
      expectedExitCodes: [0],
      status: 'pending',
    }],
  };
}

describe('confirmed plan command permissions', () => {
  it('maps npm installation to the approved quality-gate subproject', () => {
    const patterns = commandPatternsForPlanPermissions(plan(['shell:npm_install']));

    expect(patterns).toContain('npm --prefix yanxu-h5 install');
    expect(patterns).toContain('cd yanxu-h5 && npm install');
    expect(patterns).toContain('npm --prefix yanxu-h5 ci');
    expect(patterns).not.toContain('npm install');
    expect(patterns).not.toContain('npm --prefix * install');
  });

  it('does not grant install commands without the canonical plan capability', () => {
    expect(commandPatternsForPlanPermissions(plan(['shell:npm_run_test']))).toEqual([]);
  });

  it('fails closed when a prefixed gate contains a shell-like argument', () => {
    expect(commandPatternsForPlanPermissions(
      plan(['shell:npm_install'], ['npm', '--prefix', 'yanxu-h5;rm', 'run', 'test']),
    )).toEqual([]);
  });

  it('fails closed when a prefixed gate escapes the approved project root', () => {
    expect(commandPatternsForPlanPermissions(
      plan(['shell:npm_install'], ['npm', '--prefix', '../outside', 'run', 'test']),
    )).toEqual([]);
  });
});

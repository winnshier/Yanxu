import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { DomainError } from './errors.js';
import { YanxuStore } from './store.js';

const temporaryDirectories: string[] = [];
const availableOpenCode: ExecutorInstallation = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  path: '/tmp/opencode',
  version: 'test',
  health: 'available',
  capabilities: ['structured-output'],
  models: ['test-model'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('task cancellation', () => {
  it('preserves a stopped task but removes it from the default task board', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-task-cancellation-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    const workbench = join(root, 'workbench');
    mkdirSync(projectDirectory);
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const agent = store.createAgent({
      name: '产品',
      roleId: 'product',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '废弃任务测试团队', memberIds: [agent.id] });
    const project = store.createProject({ name: '废弃任务测试项目', directoryPath: projectDirectory });
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '不再实施的需求',
      description: '该任务将被终止并废弃。',
    });

    task = store.submitTask(task.id, task.stateVersion);
    task = store.commandTask(task.id, 'stop', task.stateVersion);
    task = store.commandTask(task.id, 'cancel', task.stateVersion);

    expect(task.status).toBe('CANCELLED');
    expect(store.listTasks().some((item) => item.id === task.id)).toBe(false);
    expect(store.listTasks({ includeArchived: true })).toEqual([
      expect.objectContaining({ id: task.id, status: 'CANCELLED' }),
    ]);
    expect(store.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.cancel' }),
    ]));
    expect(database.prepare(`
      SELECT status FROM jobs WHERE aggregate_id = ? AND type = 'COMPOSE_PLAN'
    `).get(task.id)).toEqual({ status: 'CANCELLED' });
    expect(() => store.commandTask(task.id, 'resume', task.stateVersion)).toThrow(DomainError);

    task = store.commandTask(task.id, 'reopen', task.stateVersion, '误操作废弃，恢复为新需求版本。');
    expect(task.status).toBe('REOPENED');
    expect(store.listTasks().some((item) => item.id === task.id)).toBe(true);
    database.close();
  });
});

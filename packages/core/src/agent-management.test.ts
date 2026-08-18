import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];
const installation: ExecutorInstallation = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  path: '/tmp/fake-opencode',
  version: 'test',
  health: 'available',
  capabilities: ['structured-output'],
  models: ['test/model', 'test/updated'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AI agent lifecycle', () => {
  it('edits and deactivates agents while refusing unsafe deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-agent-management-'));
    roots.push(root);
    const database = openDatabase(join(root, 'system', 'app.db'));
    const store = new YanxuStore(database, root);
    const referenced = store.createAgent({
      name: '研发一号',
      roleId: 'implementation-worker',
      executor: 'opencode',
      model: 'test/model',
    }, installation);
    const disposable = store.createAgent({
      name: '临时人员',
      roleId: 'code-reviewer',
      executor: 'opencode',
      model: 'test/model',
    }, installation);

    expect(store.updateAgent(referenced.id, {
      name: '研发主力',
      roleId: 'implementation-worker',
      executor: 'opencode',
      model: 'test/updated',
      permissionMode: 'managed',
    }, installation)).toMatchObject({
      name: '研发主力',
      model: 'test/updated',
      permissionMode: 'managed',
      status: 'active',
    });
    const team = store.createTeam({ name: '研发团队', memberIds: [referenced.id] });
    expect(team.memberIds).toEqual([referenced.id]);
    expect(store.setAgentStatus(referenced.id, 'inactive')).toMatchObject({ status: 'inactive' });
    expect(() => store.createTeam({ name: '错误团队', memberIds: [referenced.id] })).toThrow('不能加入已停用人员');
    expect(() => store.deleteAgent(referenced.id)).toThrow('不能删除');

    expect(store.deleteAgent(disposable.id)).toEqual({ deletedAgentId: disposable.id });
    expect(() => store.getAgent(disposable.id)).toThrow('不存在');
    const validation = store.saveExecutorValidation({
      executor: 'opencode',
      status: 'passed',
      message: 'runtime ready',
      version: 'test',
      capabilities: ['structured-output'],
      models: ['test/model'],
      loginStatus: 'configured',
      checkedAt: new Date().toISOString(),
    });
    expect(store.listExecutorValidations()).toEqual([validation]);
    expect(store.systemDiagnostics()).toMatchObject({
      databaseCheck: 'ok',
      indexedProjectFiles: 0,
      runtimeTaskDirectories: 0,
      gitVersion: expect.stringContaining('git version'),
    });
    expect(store.dashboard([]).systemAttention).toEqual([
      expect.objectContaining({ type: 'executor', title: '全局协调 CLI 不可用' }),
    ]);
    store.updateSettings({ coordinatorModel: 'test/model' });
    expect(store.dashboard([installation]).systemAttention).toEqual([]);
    database.close();
  });
});

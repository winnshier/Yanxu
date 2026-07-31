import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];
const executor: ExecutorInstallation = {
  id: 'opencode', name: 'OpenCode', command: 'opencode', path: '/tmp/opencode', version: 'test',
  health: 'available', capabilities: ['structured-output'], models: ['test-model'],
  lastCheckedAt: new Date().toISOString(), error: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('task diagnostics', () => {
  it('aggregates classified failures, retries and the current status reason from existing evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-diagnostics-'));
    roots.push(root);
    const repository = join(root, 'repository');
    mkdirSync(repository);
    const database = openDatabase(join(root, 'workbench', 'system', 'app.db'));
    const store = new YanxuStore(database, join(root, 'workbench'));
    const agent = store.createAgent({ name: '研发', roleId: 'development', executor: 'opencode', model: 'test-model' }, executor);
    const team = store.createTeam({ name: '诊断团队', memberIds: [agent.id] });
    const project = store.createProject({ name: '诊断项目', directoryPath: repository });
    let task = store.createTask({ projectId: project.id, teamId: team.id, title: '诊断重试', description: '同一故障不盲重试。' });
    task = store.submitTask(task.id, task.stateVersion);

    const first = store.claimReadyJob('daemon-test');
    if (!first) throw new Error('first job missing');
    store.failJob(first, new Error('Injected runtime crash in session_first after 1000 ms'));
    database.prepare(`UPDATE jobs SET available_at = ? WHERE id = ?`).run(new Date(0).toISOString(), first.id);
    const second = store.claimReadyJob('daemon-test');
    if (!second) throw new Error('second job missing');
    store.failJob(second, new Error('Injected runtime crash in session_second after 2000 ms'));

    const diagnostics = store.getTaskDiagnostics(task.id);
    expect(diagnostics).toMatchObject({
      status: 'BLOCKED',
      jobs: { retries: 1, failed: 1 },
      quality: { status: 'not_configured' },
    });
    expect(diagnostics.failures).toHaveLength(2);
    expect(diagnostics.failures[1]).toMatchObject({ category: 'transient', repeated: true });
    expect(diagnostics.statusReason?.message).toContain('相同失败重复出现');
    database.close();
  });
});

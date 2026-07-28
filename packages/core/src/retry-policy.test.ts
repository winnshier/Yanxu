import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  models: ['test/model'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('automatic failure policy', () => {
  it('allows two implementation fixes, one automatic replan, then blocks', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-retry-policy-'));
    roots.push(root);
    const repository = join(root, 'repository');
    mkdirSync(repository);
    const database = openDatabase(join(root, 'workbench', 'system', 'app.db'));
    const store = new YanxuStore(database, join(root, 'workbench'));
    const developer = store.createAgent({
      name: '研发',
      roleId: 'development',
      executor: 'opencode',
      model: 'test/model',
    }, installation);
    const team = store.createTeam({ name: '重试团队', memberIds: [developer.id] });
    const project = store.createProject({ name: '重试项目', directoryPath: repository });
    const directoryId = project.directories[0]?.id ?? '';
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '验证失败策略',
      description: '门禁持续失败。',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '验证失败策略',
      scope: ['repository'],
      nonScope: [],
      successCriteria: ['按策略进入 BLOCKED'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: [],
      steps: [{
        id: 'retry-implementation',
        position: 0,
        skillId: 'implementation',
        agentId: developer.id,
        title: '实施',
        description: '尝试修复。',
        inputs: ['需求'],
        expectedOutput: '实现摘要',
        directoryIds: [directoryId],
      }],
      qualityGates: [],
    });
    if (!task.plan) throw new Error('plan missing');
    const confirmedPlan = {
      ...task.plan,
      questions: task.plan.questions.map((question) => ({ ...question, answer: '按测试基线执行' })),
      answersReviewedAt: new Date().toISOString(),
    };
    database.prepare('UPDATE plans SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(confirmedPlan), task.plan.id);
    task = store.getTask(task.id);
    task = store.commandTask(task.id, 'confirm', task.stateVersion);

    const forceValidationAttempt = (attempt: number) => {
      database.prepare(`UPDATE tasks SET status = 'VALIDATING' WHERE id = ?`).run(task.id);
      database.prepare(`
        UPDATE task_steps SET status = 'succeeded', attempt = ?, completed_at = ? WHERE task_id = ?
      `).run(attempt, new Date().toISOString(), task.id);
    };

    forceValidationAttempt(1);
    task = store.retryAfterGateFailure(task.id, 2);
    expect(task).toMatchObject({ status: 'RETRYING' });

    forceValidationAttempt(2);
    task = store.retryAfterGateFailure(task.id, 2);
    expect(task).toMatchObject({ status: 'RETRYING' });

    forceValidationAttempt(3);
    task = store.retryAfterGateFailure(task.id, 2);
    expect(task).toMatchObject({ status: 'REPLANNING' });

    database.prepare(`UPDATE tasks SET status = 'VALIDATING' WHERE id = ?`).run(task.id);
    task = store.requestAutomaticReplan(task.id, '重新规划后仍然失败', 'gate_retries_exhausted', true);
    expect(task).toMatchObject({ status: 'BLOCKED' });
    expect(store.listEvents(task.id).map((event) => event.type)).toEqual(expect.arrayContaining([
      'task.retrying',
      'task.replan_requested',
      'task.blocked',
    ]));
    database.close();
  });
});

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation, TaskPlan } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];
const openCode: ExecutorInstallation = {
  id: 'opencode', name: 'OpenCode', command: 'opencode', path: '/tmp/opencode', version: 'test',
  health: 'available', capabilities: ['sessions', 'structured-output', 'permissions', 'abort'], models: ['test/model'],
  lastCheckedAt: new Date().toISOString(), error: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkUnit flow', () => {
  it('uses the team as a candidate pool and persists work-unit execution boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-work-unit-'));
    roots.push(root);
    const projectDirectory = join(root, 'project');
    mkdirSync(projectDirectory);
    const database = openDatabase(join(root, 'workbench', 'system', 'app.db'));
    const store = new YanxuStore(database, join(root, 'workbench'));
    const productAgent = store.createAgent({
      name: '通用执行人员', roleId: 'product-analyst', executor: 'opencode', model: 'test/model', permissionMode: 'managed',
    }, openCode);
    const team = store.createTeam({ name: '轻量团队', memberIds: [productAgent.id] });
    const project = store.createProject({ name: '空项目', directoryPath: projectDirectory });
    const directoryId = project.directories[0]!.id;

    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '实现一个小功能',
      description: '由当前团队中的通用人员完成，不要求开发 Role 或 implementation Skill。',
      expectedOutput: '真实文件改动与验证结论',
    });
    task = store.submitTask(task.id, task.stateVersion);
    expect(() => store.saveComposedPlan(task.id, { steps: [] }))
      .toThrow('计划必须根据当前任务明确生成至少一个 WorkUnit');
    const steps: TaskPlan['steps'] = [{
      id: 'draft_work_unit',
      position: 0,
      unitKey: 'work-unit',
      agentId: productAgent.id,
      title: '实现并验证功能',
      description: '使用 CLI 原生能力完成项目修改。',
      inputs: ['用户需求', '项目现状'],
      expectedOutput: '可由 Git 重建的改动',
      directoryIds: [directoryId],
      requiredCapabilities: ['项目检索', '代码实现', '验证'],
      verification: ['检查 Git diff', '执行项目测试'],
      mode: 'write',
      requiresIndependentSession: false,
    }];
    task = store.saveComposedPlan(task.id, {
      goal: '完成真实项目改动', scope: ['所选目录'], nonScope: ['远程发布'], successCriteria: ['改动可验证'],
      assumptions: [], risks: [], questions: [], permissions: ['写入隔离工作区'], steps,
    });

    expect(task).toMatchObject({ status: 'WAITING_PLAN_APPROVAL' });
    expect(task.steps).toEqual([
      expect.objectContaining({
        unitKey: 'work-unit', agentId: productAgent.id, mode: 'write',
        requiredCapabilities: ['项目检索', '代码实现', '验证'],
        verification: ['检查 Git diff', '执行项目测试'],
      }),
    ]);

    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    const snapshot = store.getRunSnapshot(task.id);
    expect(snapshot?.permissionManifests).toEqual([
      expect.objectContaining({ agentId: productAgent.id, readOnly: false }),
    ]);

    const plannedStep = task.steps[0]!;
    const sessionRecordId = store.createAgentSession(task.id, plannedStep, productAgent);
    store.recordExternalSessionId(sessionRecordId, 'opencode-session-1');
    store.recordSessionFailure(sessionRecordId, plannedStep.id, '模拟进程中断');
    expect(store.getResumableExternalSession(task.id, productAgent.id)).toBe('opencode-session-1');
    database.prepare(`UPDATE task_steps SET status = 'succeeded', attempt = 1 WHERE id = ?`).run(plannedStep.id);
    database.prepare(`UPDATE tasks SET status = 'VALIDATING', active_step_id = NULL WHERE id = ?`).run(task.id);
    task = store.retryAfterGateFailure(task.id, 2);
    expect(task).toMatchObject({ status: 'RETRYING' });
    expect(task.steps[0]).toMatchObject({ status: 'pending', attempt: 1, mode: 'write' });
    expect(store.getResumableExternalSession(task.id, productAgent.id)).toBe('opencode-session-1');
    database.close();
  });

  it('freezes different CLI runtimes and independent reviewer responsibility in one team plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-cross-cli-'));
    roots.push(root);
    const projectDirectory = join(root, 'project');
    mkdirSync(projectDirectory);
    const database = openDatabase(join(root, 'workbench', 'system', 'app.db'));
    const store = new YanxuStore(database, join(root, 'workbench'));
    const claude: ExecutorInstallation = {
      id: 'claude', name: 'Claude Code', command: 'claude', path: '/tmp/claude', version: '2.1.0',
      health: 'available', capabilities: ['sessions', 'structured-output', 'permissions', 'abort'], models: ['sonnet'],
      lastCheckedAt: new Date().toISOString(), error: null,
    };
    const developer = store.createAgent({
      name: 'OpenCode 研发', roleId: 'implementation-worker', executor: 'opencode', model: 'test/model',
    }, openCode);
    const reviewer = store.createAgent({
      name: 'Claude 评审', roleId: 'code-reviewer', executor: 'claude', model: 'sonnet',
    }, claude);
    const team = store.createTeam({ name: '双 CLI 团队', memberIds: [developer.id, reviewer.id] });
    const project = store.createProject({ name: '双 CLI 项目', directoryPath: projectDirectory });
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '跨 CLI 交付',
      description: '研发后独立评审。',
      expectedOutput: '经过独立评审的可验证交付结果',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      questions: [],
      steps: [
        {
          id: 'implementation', position: 0, unitKey: 'work-unit', agentId: developer.id,
          title: '实施', description: '完成真实修改。', inputs: [], expectedOutput: '变更', directoryIds: [project.directories[0]!.id],
          requiredCapabilities: [], verification: ['检查 diff'], mode: 'write', requiresIndependentSession: false,
        },
        {
          id: 'review', position: 1, unitKey: 'work-unit', agentId: reviewer.id,
          title: '独立评审', description: '独立核对修改。', inputs: ['变更'], expectedOutput: '结论', directoryIds: [project.directories[0]!.id],
          requiredCapabilities: [], verification: ['核对证据'], mode: 'read_only', requiresIndependentSession: true,
        },
      ],
    });
    task = store.commandTask(task.id, 'confirm', task.stateVersion, undefined, [openCode, claude]);
    const snapshot = store.getRunSnapshot(task.id);
    expect(snapshot?.executors).toEqual(expect.arrayContaining([
      expect.objectContaining({ executor: 'opencode', version: 'test', selectedModels: ['test/model'] }),
      expect.objectContaining({ executor: 'claude', version: '2.1.0', selectedModels: ['sonnet'] }),
    ]));
    expect(snapshot?.plan.steps[1]).toMatchObject({ agentId: reviewer.id, requiresIndependentSession: true, mode: 'read_only' });
    database.close();
  });
});

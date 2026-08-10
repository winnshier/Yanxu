import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
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
  models: ['test/model'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('scheduler recovery', () => {
  it('immediately returns a job leased by an old daemon instance to the ready queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-recovery-test-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    mkdirSync(projectDirectory);
    const databasePath = join(root, 'workbench', 'system', 'app.db');
    const database = openDatabase(databasePath);
    const store = new YanxuStore(database, join(root, 'workbench'));
    const project = store.createProject({ name: '恢复测试', directoryPath: projectDirectory });
    const team = store.listTeams()[0];
    if (!team) throw new Error('default team missing');
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '验证重启恢复',
      description: 'Daemon 重启后继续计划任务。',
    });
    task = store.submitTask(task.id, task.stateVersion);

    const leased = store.claimReadyJob('daemon_old');
    expect(leased?.aggregateId).toBe(task.id);
    database.close();

    const restartedDatabase = openDatabase(databasePath);
    const restartedStore = new YanxuStore(restartedDatabase, join(root, 'workbench'));
    expect(restartedStore.reconcileExpiredLeases('daemon_new')).toBe(1);
    expect(restartedStore.getTaskEvidence(task.id).recoveries).toEqual([
      expect.objectContaining({
        jobId: leased?.id,
        reason: 'daemon_restarted',
        previousOwner: 'daemon_old',
        recoveredBy: 'daemon_new',
      }),
    ]);
    const recovered = restartedStore.claimReadyJob('daemon_new');
    expect(recovered?.id).toBe(leased?.id);
    restartedDatabase.close();
  });

  it('requeues an active task that has no ready or leased job', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-orphan-recovery-test-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    mkdirSync(projectDirectory);
    const workbench = join(root, 'workbench');
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const developer = store.createAgent({
      name: '恢复研发',
      roleId: 'development',
      executor: 'opencode',
      model: 'test/model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '恢复团队', memberIds: [developer.id] });
    const project = store.createProject({ name: '悬空恢复项目', directoryPath: projectDirectory });
    const directoryId = project.directories[0]?.id;
    if (!directoryId) throw new Error('directory missing');
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '恢复悬空实施任务',
      description: '实施任务进入重试状态后不能丢失后台作业。',
      expectedOutput: '实际文件变更',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '恢复悬空任务',
      scope: ['project'],
      nonScope: [],
      successCriteria: ['后台作业被重新创建'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['写入隔离工作区'],
      steps: [{
        id: 'orphan-implementation',
        position: 0,
        unitKey: 'work-unit',
        agentId: developer.id,
        title: '内容实施',
        description: '产生实际文件变更。',
        inputs: ['计划'],
        expectedOutput: '实现报告',
        directoryIds: [directoryId],
      }],
      qualityGates: [],
    });
    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    task = store.savePreparedWorkspaces(task.id, [{
      taskId: task.id,
      directoryId,
      workspacePath: projectDirectory,
      scopePath: projectDirectory,
      baselineCommit: 'baseline',
      taskBranch: 'yanxu/orphan',
      targetBranch: 'main',
    }]);
    database.prepare('DELETE FROM jobs WHERE aggregate_id = ?').run(task.id);
    database.prepare(`UPDATE tasks SET status = 'RETRYING' WHERE id = ?`).run(task.id);

    expect(store.reconcileOrphanedActiveTasks()).toBe(1);
    const recoveredJob = database.prepare(`
      SELECT id, type, status, dedupe_key FROM jobs WHERE aggregate_id = ?
    `).get(task.id) as { id: string; type: string; status: string; dedupe_key: string };
    expect(recoveredJob).toMatchObject({
      type: 'RUN_WORK_UNIT',
      status: 'READY',
    });
    expect(recoveredJob.dedupe_key).toContain('orphan-recovery');
    expect(store.getTaskEvidence(task.id).recoveries).toEqual([
      expect.objectContaining({
        jobId: recoveredJob.id,
        reason: 'active_task_without_job',
        action: 'run_work_unit_enqueued',
      }),
    ]);
    expect(store.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'recovery.orphaned_task' }),
    ]));
    database.close();
  });

  it('keeps historical replan steps outside the runnable plan and cleans polluted history on resume', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-historical-step-recovery-test-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    mkdirSync(projectDirectory);
    const workbench = join(root, 'workbench');
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const developer = store.createAgent({
      name: '历史步骤恢复研发',
      roleId: 'development',
      executor: 'opencode',
      model: 'test/model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '历史步骤恢复团队', memberIds: [developer.id] });
    const project = store.createProject({ name: '历史步骤恢复项目', directoryPath: projectDirectory });
    const directoryId = project.directories[0]?.id;
    if (!directoryId) throw new Error('directory missing');
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '不执行旧计划步骤',
      description: '重新规划后只执行当前确认计划。',
      expectedOutput: '当前计划交付物',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '验证历史步骤隔离',
      scope: ['project'],
      nonScope: [],
      successCriteria: ['历史步骤不进入调度'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['写入隔离工作区'],
      steps: [{
        id: 'current-implementation',
        position: 0,
        unitKey: 'work-unit',
        agentId: developer.id,
        title: '当前计划实施',
        description: '只执行当前计划。',
        inputs: ['计划'],
        expectedOutput: '实现报告',
        directoryIds: [directoryId],
      }],
      qualityGates: [],
    });
    const currentStepId = task.steps[0]?.id;
    if (!currentStepId) throw new Error('current step missing');
    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    task = store.savePreparedWorkspaces(task.id, [{
      taskId: task.id,
      directoryId,
      workspacePath: projectDirectory,
      scopePath: projectDirectory,
      baselineCommit: 'baseline',
      taskBranch: 'yanxu/history',
      targetBranch: 'main',
    }]);

    const historicalStepId = 'historical-technical-design';
    database.prepare(`
      INSERT INTO task_steps(
        id, task_id, position, unit_key, agent_id, title, description,
        inputs_json, expected_output, directory_ids_json, status
      ) VALUES (?, ?, 1001, 'technical-design', ?, '旧计划技术设计', '不得再次执行',
        '[]', '旧计划产物', ?, 'skipped')
    `).run(historicalStepId, task.id, developer.id, JSON.stringify([directoryId]));

    task = store.requestAutomaticReplan(task.id, '当前计划需要重新组合。', 'test', true);
    expect(database.prepare('SELECT status FROM task_steps WHERE id = ?').get(historicalStepId))
      .toEqual({ status: 'skipped' });
    expect(task.steps.map((step) => step.id)).not.toContain(historicalStepId);

    database.prepare('DELETE FROM jobs WHERE aggregate_id = ?').run(task.id);
    database.prepare(`UPDATE task_steps SET status = 'succeeded' WHERE id = ?`).run(currentStepId);
    database.prepare(`UPDATE task_steps SET status = 'running' WHERE id = ?`).run(historicalStepId);
    database.prepare(`UPDATE tasks SET status = 'STOPPED', active_step_id = ? WHERE id = ?`)
      .run(historicalStepId, task.id);

    task = store.getTask(task.id);
    expect(task.steps.map((step) => step.id)).toEqual([currentStepId]);
    task = store.commandTask(task.id, 'resume', task.stateVersion);
    expect(task).toMatchObject({ status: 'DELIVERED', activeStepId: null });
    expect(database.prepare('SELECT status FROM task_steps WHERE id = ?').get(historicalStepId))
      .toEqual({ status: 'skipped' });
    database.close();
  });
});

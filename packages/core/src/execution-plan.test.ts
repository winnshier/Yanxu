import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation, TaskPlan } from '@yanxu/contracts';
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
  models: ['test-model'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('dynamic execution plans', () => {
  it('persists only the skills selected by the coordinator and initializes Git after confirmation', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-plan-test-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    const workbench = join(root, 'workbench');
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    mkdirSync(projectDirectory);
    const store = new YanxuStore(database, workbench);
    const product = store.createAgent({
      name: '产品一号',
      roleId: 'product',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const tester = store.createAgent({
      name: '测试一号',
      roleId: 'testing',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '产品测试团队', memberIds: [product.id, tester.id] });
    const project = store.createProject({
      name: '文档项目',
      directoryPath: projectDirectory,
    });

    expect(project.directories[0]?.gitInitialized).toBe(false);

    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '梳理并验证功能点',
      description: '只需要产品梳理功能点并由测试验证，不修改代码。',
      expectedOutput: '功能点与测试结论',
    });
    task = store.submitTask(task.id, task.stateVersion);
    const directoryId = project.directories[0]?.id ?? '';
    const proposedSteps: TaskPlan['steps'] = [
      {
        id: 'draft_product',
        position: 0,
        skillId: 'requirement-specification',
        agentId: product.id,
        title: '梳理功能点',
        description: '形成清晰功能点和验收标准。',
        inputs: ['用户需求'],
        expectedOutput: 'RequirementSpec',
        directoryIds: [directoryId],
      },
      {
        id: 'draft_test',
        position: 1,
        skillId: 'test-design',
        agentId: tester.id,
        title: '设计验证范围',
        description: '根据功能点形成验证结论。',
        inputs: ['RequirementSpec'],
        expectedOutput: 'TestPlan',
        directoryIds: [directoryId],
      },
    ];

    task = store.saveComposedPlan(task.id, {
      goal: '完成产品与测试协作',
      scope: ['功能点', '测试范围'],
      nonScope: ['代码实现'],
      successCriteria: ['功能点和测试结论可追溯'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取项目目录', '写入 ProjectSpace'],
      steps: proposedSteps,
    });

    expect(task.steps.map((step) => step.skillId)).toEqual(['requirement-specification', 'test-design']);
    expect(task.plan?.steps).toHaveLength(2);
    expect(task.plan?.branchRoutes[0]?.sourceCommit).toBe('UNBORN');

    task = store.updatePlanAnswers(task.id, {
      answers: {},
      stepAssignments: task.plan?.steps.map((step) => ({ stepId: step.id, agentId: step.agentId })) ?? [],
      branchRoutes: task.plan?.branchRoutes.map((route) => ({
        directoryId: route.directoryId,
        sourceBranch: 'main',
        targetBranch: 'main',
      })) ?? [],
    });
    task = store.requestPlanRevision(task.id, {
      stateVersion: task.stateVersion,
      feedback: '保留两个步骤，但让测试步骤明确验证可追溯性。',
    });
    expect(task.status).toBe('REPLANNING');
    task = store.saveComposedPlan(task.id, {
      goal: '完成产品与测试协作',
      scope: ['功能点', '测试范围'],
      nonScope: ['代码实现'],
      successCriteria: ['功能点和测试结论可追溯'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取项目目录', '写入 ProjectSpace'],
      steps: proposedSteps.map((step) => step.skillId === 'test-design'
        ? { ...step, title: '验证功能点可追溯性' }
        : step),
    });
    expect(task.status).toBe('WAITING_REAPPROVAL');
    expect(task.plan?.version).toBe(3);
    expect(task.steps[1]?.title).toBe('验证功能点可追溯性');
    expect(store.listTaskPlans(task.id).map((plan) => plan.version)).toEqual([3, 2, 1]);
    task = store.commandTask(task.id, 'stop', task.stateVersion);
    expect(task.status).toBe('STOPPED');
    task = store.commandTask(task.id, 'resume', task.stateVersion);
    expect(task.status).toBe('WAITING_REAPPROVAL');
    task = store.commandTask(task.id, 'confirm', task.stateVersion);

    expect(task.status).toBe('PREPARING');
    expect(task.snapshot?.planVersion).toBe(3);
    const snapshot = store.getRunSnapshot(task.id);
    expect(snapshot?.agents.map((agent) => agent.id)).toEqual([product.id, tester.id]);
    store.updateTeam(team.id, { name: team.name, memberIds: [] });
    expect(store.getRunSnapshot(task.id)?.team.memberIds).toEqual([product.id, tester.id]);
    task = store.commandTask(task.id, 'stop', task.stateVersion);
    task = store.commandTask(task.id, 'resume', task.stateVersion);
    expect(task.status).toBe('PREPARING');
    const initializedProject = store.ensureTaskDirectoriesGit(task.id);
    expect(initializedProject.directories[0]?.gitInitialized).toBe(true);
    expect(initializedProject.directories[0]?.currentBranch).toBe('main');
    database.close();
  });

  it('requires ambiguity answers to be incorporated by the coordinator before confirmation', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-answer-review-test-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    const workbench = join(root, 'workbench');
    mkdirSync(projectDirectory);
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const product = store.createAgent({
      name: '产品一号',
      roleId: 'product',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '需求团队', memberIds: [product.id] });
    const project = store.createProject({ name: '需求项目', directoryPath: projectDirectory });
    const directoryId = project.directories[0]?.id ?? '';
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '确认导出格式',
      description: '增加数据导出。',
      expectedOutput: '可验收的导出功能',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '增加数据导出',
      scope: ['导出功能'],
      nonScope: [],
      successCriteria: ['生成用户选择的格式'],
      assumptions: [],
      risks: [],
      questions: [{ id: 'format-question', question: '导出格式是什么？', answer: null }],
      permissions: ['读取项目目录'],
      steps: [{
        id: 'requirement-step',
        position: 0,
        skillId: 'requirement-specification',
        agentId: product.id,
        title: '需求规格',
        description: '固化导出格式。',
        inputs: ['用户需求'],
        expectedOutput: 'RequirementSpec',
        directoryIds: [directoryId],
      }],
      qualityGates: [],
    });
    task = store.updatePlanAnswers(task.id, { answers: { 'format-question': 'CSV' } });
    expect(task.plan).toMatchObject({ taskVersion: 2 });
    expect(store.getTaskEvidence(task.id).requirementVersions).toEqual([
      expect.objectContaining({ version: 1, status: 'superseded' }),
      expect.objectContaining({ version: 2, status: 'draft' }),
    ]);

    expect(() => store.commandTask(task.id, 'confirm', task.stateVersion))
      .toThrow('歧义答案需要先交给协调器完善计划');

    task = store.requestPlanRevision(task.id, {
      stateVersion: task.stateVersion,
      feedback: '把 CSV 答案吸收到成功标准。',
    });
    task = store.saveComposedPlan(task.id, {
      goal: '增加 CSV 数据导出',
      scope: ['CSV 导出功能'],
      nonScope: [],
      successCriteria: ['生成 UTF-8 CSV 文件'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取项目目录'],
      steps: task.steps.map((step) => ({
        id: step.id,
        position: step.position,
        skillId: step.skillId,
        agentId: step.agentId,
        title: step.title,
        description: step.description,
        inputs: step.inputs,
        expectedOutput: step.expectedOutput,
        directoryIds: step.directoryIds,
      })),
      qualityGates: [],
      answersReviewedAt: new Date().toISOString(),
    });
    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    expect(task.status).toBe('PREPARING');
    expect(store.getRunSnapshot(task.id)?.taskVersion).toMatchObject({
      id: task.plan?.taskVersionId,
      version: 2,
      status: 'approved',
    });
    database.close();
  });

  it('detects an externally modified plan artifact before confirmation', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-project-space-integrity-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    const workbench = join(root, 'workbench');
    mkdirSync(projectDirectory);
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const developer = store.createAgent({
      name: '研发一号',
      roleId: 'development',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '研发团队', memberIds: [developer.id] });
    const project = store.createProject({ name: '完整性项目', directoryPath: projectDirectory });
    const directoryId = project.directories[0]?.id ?? '';
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '实现本地功能',
      description: '实现一个明确的小功能。',
      expectedOutput: '功能完成',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '实现本地功能',
      scope: ['项目目录'],
      nonScope: ['远程发布'],
      successCriteria: ['功能完成'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取和写入隔离工作区'],
      steps: [{
        id: 'implementation-step',
        position: 0,
        skillId: 'implementation',
        agentId: developer.id,
        title: '实现功能',
        description: '按批准范围实现。',
        inputs: ['任务需求'],
        expectedOutput: '实现摘要',
        directoryIds: [directoryId],
      }],
      qualityGates: [],
    });
    expect(store.checkProjectSpaceIntegrity(project.id)).toMatchObject({
      status: 'healthy',
      issues: [],
    });
    const planRow = database.prepare('SELECT artifact_path FROM plans WHERE id = ?')
      .get(task.plan?.id) as { artifact_path: string };
    writeFileSync(planRow.artifact_path, `${readFileSync(planRow.artifact_path, 'utf8')}\n外部修改\n`);
    expect(store.checkProjectSpaceIntegrity(project.id).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'plan',
        entityId: task.plan?.id,
        reason: 'modified',
      }),
    ]));
    expect(() => store.commandTask(task.id, 'confirm', task.stateVersion))
      .toThrow('已在 ProjectSpace 外部发生变化');
    database.close();
  });
});

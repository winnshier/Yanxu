import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation, TaskPlan } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { GitWorkspaceManager } from './git-workspace.js';
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

function git(repository: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('execution evidence chain', () => {
  it('persists ArtifactVersion and injects it into the next minimal ContextPack', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-evidence-test-'));
    temporaryDirectories.push(root);
    const repository = join(root, 'repository');
    const workbench = join(root, 'workbench');
    mkdirSync(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repository, 'README.md'), '# Test\n');
    git(repository, 'add', 'README.md');
    git(repository, 'commit', '-m', 'initial');

    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const product = store.createAgent({
      name: '产品',
      roleId: 'product-analyst',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const developer = store.createAgent({
      name: '研发',
      roleId: 'implementation-worker',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '证据团队', memberIds: [product.id, developer.id] });
    const project = store.createProject({ name: '证据项目', directoryPath: repository });
    const directoryId = project.directories[0]?.id;
    if (!directoryId) throw new Error('directory missing');

    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '实现证据链',
      description: '先形成需求规格，再完成技术设计。',
      expectedOutput: '需求规格与技术方案',
    });
    const attachmentPath = join(root, 'requirement-notes.md');
    writeFileSync(attachmentPath, '# 补充说明\n\n异常路径必须有验收标准。\n');
    const attachments = store.attachTaskFiles(task.id, [attachmentPath]);
    expect(attachments).toEqual([
      expect.objectContaining({
        fileName: 'requirement-notes.md',
        contentPreview: expect.stringContaining('异常路径'),
        contentTruncated: false,
      }),
    ]);
    expect(store.checkProjectSpaceIntegrity(project.id).issues).toEqual([]);
    task = store.submitTask(task.id, task.stateVersion);
    const steps: TaskPlan['steps'] = [
      {
        id: 'draft_requirement',
        position: 0,
        unitKey: 'work-unit',
        agentId: product.id,
        title: '需求规格',
        description: '固化验收标准。',
        inputs: ['用户需求'],
        expectedOutput: 'RequirementSpec',
        directoryIds: [directoryId],
      },
      {
        id: 'draft_design',
        position: 1,
        unitKey: 'work-unit',
        agentId: developer.id,
        title: '技术设计',
        description: '消费需求规格。',
        inputs: ['RequirementSpec'],
        expectedOutput: 'TechnicalPlan',
        directoryIds: [directoryId],
      },
    ];
    task = store.saveComposedPlan(task.id, {
      goal: '建立可追溯证据链',
      scope: ['repository'],
      nonScope: ['远程发布'],
      successCriteria: ['技术设计引用验收标准'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取项目目录', '写入隔离工作区'],
      steps,
      qualityGates: [],
    });
    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    const manager = new GitWorkspaceManager(workbench);
    const workspaces = manager.prepare(task, store.ensureTaskDirectoriesGit(task.id));
    task = store.savePreparedWorkspaces(task.id, workspaces);

    const firstStep = store.startOrResumeStep(task.id);
    const firstAgent = store.getAgent(firstStep.agentId ?? '');
    const sessionId = store.createAgentSession(task.id, firstStep, firstAgent, {
      runtimeDirectory: join(workbench, 'runtime', 'tasks', task.id, 'executor'),
    });
    store.recordExecutionRunEvent(sessionId, {
      kind: 'status',
      message: '执行器已进入真实运行态。',
      occurredAt: new Date().toISOString(),
      data: { phase: 'executing' },
    });
    const checkpoints = workspaces.map((workspace) => {
      const baseCommit = manager.head(workspace);
      const inspection = manager.inspectChanges(workspace, baseCommit, [''], []);
      return {
        directoryId: workspace.directoryId,
        baseCommit,
        commit: manager.checkpoint(workspace, 'test: requirement evidence'),
        inspection,
      };
    });
    task = store.completeStep(task.id, firstStep.id, sessionId, 'external-session', {
      summary: '需求规格已完成。',
      artifacts: [{
        type: 'requirement-spec',
        title: 'Requirement Spec',
        content: '## Acceptance Criteria\n\n- AC-1：技术设计必须引用该标准。',
      }],
    }, checkpoints);

    const knowledgeTimestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO knowledge_items(
        id, project_id, category, title, content, status, source_task_id,
        version, supersedes_id, created_at, updated_at
      ) VALUES ('knowledge_api_standard_candidate', ?, 'decision', 'API 验收标准',
        '技术设计必须引用 AC-1，并覆盖异常路径。', 'candidate', NULL, 1, NULL, ?, ?)
    `).run(project.id, knowledgeTimestamp, knowledgeTimestamp);
    const activeKnowledge = store.reviewKnowledge('knowledge_api_standard_candidate', 'accept');
    database.prepare(`
      INSERT INTO knowledge_items(
        id, project_id, category, title, content, status, source_task_id,
        version, supersedes_id, created_at, updated_at
      ) VALUES ('knowledge_unrelated_candidate', ?, 'fact', '移动端品牌色',
        '营销页主色使用珊瑚橙，与接口验收和技术设计无关。', 'candidate', NULL, 1, NULL, ?, ?)
    `).run(project.id, knowledgeTimestamp, knowledgeTimestamp);
    store.reviewKnowledge('knowledge_unrelated_candidate', 'accept');

    const secondStep = store.startOrResumeStep(task.id);
    const context = store.buildContextPack(task.id, secondStep.id);
    const evidence = store.getTaskEvidence(task.id);

    expect(context.upstreamArtifacts).toHaveLength(1);
    expect(context.upstreamArtifacts[0]?.content).toContain('AC-1');
    expect(context.projectKnowledge).toEqual([
      expect.objectContaining({
        id: activeKnowledge.id,
        relevanceScore: expect.any(Number),
        matchedTerms: expect.arrayContaining(['设计']),
        selectionReason: expect.stringContaining('当前任务相关'),
      }),
    ]);
    expect(context.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'knowledge',
        id: activeKnowledge.id,
        selectionReason: expect.stringContaining('当前任务相关'),
      }),
    ]));
    expect(evidence.artifacts[0]).toMatchObject({
      artifactType: 'requirement-spec',
      version: 1,
      status: 'generated',
    });
    expect(evidence.changeManifests).toHaveLength(1);
    expect(evidence.contextPacks[0]?.contentHash).toBe(context.contentHash);
    expect(evidence.runs[0]).toMatchObject({
      id: sessionId,
      stepId: firstStep.id,
      status: 'succeeded',
      phase: 'run_completed',
      retryOfRunId: null,
      executor: 'opencode',
      model: 'test-model',
      attempt: 1,
      workspaces: expect.arrayContaining([expect.objectContaining({ directoryId })]),
      logPath: expect.stringContaining(`/runs/${sessionId}/runtime.log`),
    });
    expect(readFileSync(evidence.runs[0]?.logPath ?? '', 'utf8')).toContain('执行器已进入真实运行态');
    expect(evidence.attachments[0]).toMatchObject({
      fileName: 'requirement-notes.md',
      contentPreview: expect.stringContaining('异常路径'),
    });

    const secondAgent = store.getAgent(secondStep.agentId ?? '');
    const secondSessionId = store.createAgentSession(task.id, secondStep, secondAgent);
    const secondCheckpoints = workspaces.map((workspace) => {
      const baseCommit = manager.head(workspace);
      const inspection = manager.inspectChanges(workspace, baseCommit, [''], []);
      return {
        directoryId: workspace.directoryId,
        baseCommit,
        commit: manager.checkpoint(workspace, 'test: technical design evidence'),
        inspection,
      };
    });
    task = store.completeStep(task.id, secondStep.id, secondSessionId, 'external-design-session', {
      summary: '技术设计已完成。',
      artifacts: [{
        type: 'technical-plan',
        content: '## Design\n\n实现必须满足 AC-1。',
      }],
    }, secondCheckpoints);
    expect(task.status).toBe('DELIVERED');

    task = store.commandTask(task.id, 'reopen', task.stateVersion, '缺少异常路径的验收标准，请补充后重新设计。');
    expect(task.status).toBe('REOPENED');
    expect(task.description).toContain('用户纠正（v2）');
    expect(store.getTaskEvidence(task.id).requirementVersions).toEqual([
      expect.objectContaining({ version: 1, status: 'superseded' }),
      expect.objectContaining({ version: 2, status: 'draft' }),
    ]);

    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '补充异常路径并更新设计',
      scope: ['repository'],
      nonScope: ['远程发布'],
      successCriteria: ['异常路径具有验收标准'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取项目目录', '写入隔离工作区'],
      steps,
      qualityGates: [],
    });
    expect(task.steps).toHaveLength(2);
    expect(task.steps.every((step) => step.status === 'pending')).toBe(true);
    expect(task.plan?.branchRoutes[0]?.taskBranch).toContain('-v2');
    database.close();
  }, 10_000);
});

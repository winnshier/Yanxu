import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('review enforcement', () => {
  it('routes changes_required back to implementation instead of delivering the task', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-review-test-'));
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
    const developer = store.createAgent({
      name: '研发',
      roleId: 'development',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const reviewer = store.createAgent({
      name: '评审',
      roleId: 'review',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '研发评审团队', memberIds: [developer.id, reviewer.id] });
    const project = store.createProject({ name: '评审项目', directoryPath: repository });
    const directoryId = project.directories[0]?.id ?? '';
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '实现并评审',
      description: '实现功能后必须经过独立评审。',
      expectedOutput: '通过评审的实现',
    });
    task = store.submitTask(task.id, task.stateVersion);
    const steps: TaskPlan['steps'] = [
      {
        id: 'implementation-step',
        position: 0,
        skillId: 'implementation',
        agentId: developer.id,
        title: '内容实施',
        description: '实现功能。',
        inputs: ['计划'],
        expectedOutput: '实现摘要',
        directoryIds: [directoryId],
      },
      {
        id: 'review-step',
        position: 1,
        skillId: 'delivery-review',
        agentId: reviewer.id,
        title: '交付评审',
        description: '独立检查实现。',
        inputs: ['实现', '证据'],
        expectedOutput: 'DeliveryReview',
        directoryIds: [directoryId],
      },
    ];
    task = store.saveComposedPlan(task.id, {
      goal: '实现并通过评审',
      scope: ['repository'],
      nonScope: ['远程发布'],
      successCriteria: ['评审无阻断问题'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取和写入任务工作区'],
      steps,
      qualityGates: [],
    });
    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    const manager = new GitWorkspaceManager(workbench);
    const workspaces = manager.prepare(task, store.ensureTaskDirectoriesGit(task.id));
    task = store.savePreparedWorkspaces(task.id, workspaces);

    const implementation = store.startOrResumeStep(task.id);
    const implementationSession = store.createAgentSession(task.id, implementation, developer);
    const workspace = workspaces[0];
    if (!workspace) throw new Error('workspace missing');
    const implementationBase = manager.head(workspace);
    writeFileSync(join(workspace.scopePath, 'feature.txt'), 'first implementation\n');
    const implementationInspection = manager.inspectChanges(workspace, implementationBase, [''], []);
    task = store.completeStep(task.id, implementation.id, implementationSession, 'implementation-external', {
      summary: '完成第一版实现。',
      artifacts: [{ type: 'implementation-report', content: '已实现 feature.txt。' }],
    }, [{
      directoryId,
      baseCommit: implementationBase,
      commit: manager.checkpoint(workspace, 'feat: first implementation'),
      inspection: implementationInspection,
    }]);

    const review = store.startOrResumeStep(task.id);
    const reviewSession = store.createAgentSession(task.id, review, reviewer);
    task = store.handleNonPassingStep(task.id, review.id, reviewSession, 'review-external', {
      status: 'changes_required',
      summary: '缺少异常路径处理。',
      issues: ['空输入会导致未处理异常'],
      artifacts: [{ type: 'delivery-review', content: '# Review\n\n必须补充空输入处理。' }],
      completionChecks: [
        { check: '结论引用实际证据', status: 'passed', evidence: '引用 feature.txt。' },
        { check: '偏差和限制未被隐藏', status: 'failed', evidence: '发现空输入缺口。' },
      ],
    }, 2);

    expect(task.status).toBe('RETRYING');
    expect(task.steps.map((step) => step.status)).toEqual(['pending', 'pending']);
    expect(store.getTaskEvidence(task.id).artifacts).toEqual([
      expect.objectContaining({ artifactType: 'implementation-report' }),
      expect.objectContaining({ artifactType: 'delivery-review' }),
    ]);
    expect(store.listEvents(task.id).some((event) => event.type === 'skill_step.changes_required')).toBe(true);
    database.close();
  });
});

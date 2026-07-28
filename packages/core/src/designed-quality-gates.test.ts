import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
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

function git(repository: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('test-designed quality gates', () => {
  it('persists a narrower task-specific gate without mutating the confirmed plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-designed-gates-'));
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
    const tester = store.createAgent({
      name: '测试',
      roleId: 'testing',
      executor: 'opencode',
      model: 'test-model',
    }, availableOpenCode);
    const team = store.createTeam({ name: '测试团队', memberIds: [tester.id] });
    const project = store.createProject({ name: '门禁项目', directoryPath: repository });
    const directoryId = project.directories[0]?.id;
    if (!directoryId) throw new Error('directory missing');

    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '设计专项测试',
      description: '根据成功标准生成专项测试门禁。',
      expectedOutput: '可执行的专项测试门禁',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '生成专项测试门禁',
      scope: ['repository'],
      nonScope: ['远程发布'],
      successCriteria: ['专项门禁可独立执行'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['执行已确认测试命令'],
      steps: [{
        id: 'test-design-step',
        position: 0,
        skillId: 'test-design',
        agentId: tester.id,
        title: '测试设计',
        description: '生成更窄的专项门禁。',
        inputs: ['RequirementSpec'],
        expectedOutput: 'TestPlan',
        directoryIds: [directoryId],
      }],
      qualityGates: [{
        id: 'gate_base',
        name: 'test',
        command: `${process.execPath} -e process.exit(0)`,
        commandArgv: [process.execPath, '-e', 'process.exit(0)'],
        directoryId,
        source: 'existing_project',
        required: true,
        status: 'pending',
      }],
    });
    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    const manager = new GitWorkspaceManager(workbench);
    const workspaces = manager.prepare(task, store.ensureTaskDirectoriesGit(task.id));
    task = store.savePreparedWorkspaces(task.id, workspaces);

    const step = store.startOrResumeStep(task.id);
    const session = store.createAgentSession(task.id, step, tester);
    const checkpoints = workspaces.map((workspace) => {
      const baseCommit = manager.head(workspace);
      return {
        directoryId: workspace.directoryId,
        baseCommit,
        commit: manager.checkpoint(workspace, 'test: design gate'),
        inspection: manager.inspectChanges(workspace, baseCommit, [''], []),
      };
    });
    task = store.completeStep(task.id, step.id, session, 'external-test-design', {
      summary: '专项门禁已设计。',
      artifacts: [{
        type: 'test-plan',
        content: '# Test Plan\n\n仅运行关键验收场景。',
        metadata: {
          qualityGates: [{
            name: 'critical acceptance',
            commandArgv: [process.execPath, '-e', 'process.exit(0)', '--', 'critical'],
            directoryId,
            required: true,
            timeoutMs: 30_000,
            expectedExitCodes: [0],
          }],
        },
      }],
    }, checkpoints);

    expect(task.status).toBe('VALIDATING');
    expect(task.plan?.qualityGates).toHaveLength(1);
    expect(store.getEffectiveQualityGates(task.id)).toEqual([
      expect.objectContaining({ id: 'gate_base', source: 'existing_project' }),
      expect.objectContaining({ name: 'critical acceptance', source: 'task_specific' }),
    ]);
    expect(store.getTaskEvidence(task.id).designedQualityGates).toEqual([
      expect.objectContaining({ name: 'critical acceptance' }),
    ]);
    database.close();
  });
});

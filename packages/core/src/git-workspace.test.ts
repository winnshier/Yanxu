import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project, Task } from '@yanxu/contracts';
import { GitWorkspaceManager, workingTreeFingerprint } from './git-workspace.js';

const temporaryDirectories: string[] = [];

function git(repository: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('GitWorkspaceManager', () => {
  it('freezes staged, unstaged and untracked files without changing the user worktree or index', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-git-test-'));
    temporaryDirectories.push(root);
    const repository = join(root, 'repository');
    const workbench = join(root, 'workbench');
    mkdirSync(repository);
    git(repository, 'init');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repository, 'tracked.txt'), 'base\n');
    git(repository, 'add', 'tracked.txt');
    git(repository, 'commit', '-m', 'initial');

    writeFileSync(join(repository, 'tracked.txt'), 'staged\n');
    git(repository, 'add', 'tracked.txt');
    writeFileSync(join(repository, 'tracked.txt'), 'working tree wins\n');
    writeFileSync(join(repository, 'untracked.txt'), 'new file\n');
    const statusBefore = git(repository, 'status', '--porcelain=v1');

    const project = projectFixture(repository);
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const manager = new GitWorkspaceManager(workbench);
    const [workspace] = manager.prepare(task, project);

    expect(workspace).toBeDefined();
    expect(readFileSync(join(workspace?.workspacePath ?? '', 'tracked.txt'), 'utf8')).toBe('working tree wins\n');
    expect(readFileSync(join(workspace?.workspacePath ?? '', 'untracked.txt'), 'utf8')).toBe('new file\n');
    expect(git(repository, 'status', '--porcelain=v1')).toBe(statusBefore);
  });

  it('preflights and merges a task branch into its clean target branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-merge-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const workbench = join(root, 'workbench');
    const project = projectFixture(repository);
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const manager = new GitWorkspaceManager(workbench);
    const [workspace] = manager.prepare(task, project);
    if (!workspace) throw new Error('workspace missing');
    writeFileSync(join(workspace.workspacePath, 'feature.txt'), 'implemented\n');
    manager.checkpoint(workspace, 'feat: implement task');

    const [result] = manager.mergeToTargets(task, project, [workspace]);

    expect(result?.alreadyMerged).toBe(false);
    expect(readFileSync(join(repository, 'feature.txt'), 'utf8')).toBe('implemented\n');
    expect(git(repository, 'branch', '--show-current')).toBe('master');
    expect(git(repository, 'status', '--porcelain=v1')).toBe('');
  });

  it('loads a bounded per-file diff and rejects parent-directory traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-diff-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const project = projectFixture(repository);
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const manager = new GitWorkspaceManager(join(root, 'workbench'));
    const [workspace] = manager.prepare(task, project);
    if (!workspace) throw new Error('workspace missing');
    writeFileSync(join(workspace.workspacePath, 'tracked.txt'), 'changed through task\n');
    manager.checkpoint(workspace, 'feat: change tracked file');

    const loaded = manager.diff(workspace, 'tracked.txt', 80);
    expect(loaded.diff).toContain('diff --git');
    expect(loaded.truncated).toBe(true);
    expect(() => manager.diff(workspace, '../outside.txt')).toThrow('Diff 文件路径不合法');
  });

  it('isolates two concurrent tasks that modify the same source file', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-concurrent-task-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const project = projectFixture(repository);
    const firstTask = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const secondTask = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    secondTask.id = 'task_second';
    if (!secondTask.plan) throw new Error('plan missing');
    secondTask.plan.id = 'plan_second';
    secondTask.plan.branchRoutes = secondTask.plan.branchRoutes.map((route) => ({
      ...route,
      taskBranch: 'yanxu/test-second',
    }));
    const manager = new GitWorkspaceManager(join(root, 'workbench'));
    const [firstWorkspace] = manager.prepare(firstTask, project);
    const [secondWorkspace] = manager.prepare(secondTask, project);
    if (!firstWorkspace || !secondWorkspace) throw new Error('workspaces missing');

    writeFileSync(join(firstWorkspace.workspacePath, 'tracked.txt'), 'first task\n');
    writeFileSync(join(secondWorkspace.workspacePath, 'tracked.txt'), 'second task\n');
    manager.checkpoint(firstWorkspace, 'feat: first isolated task');
    manager.checkpoint(secondWorkspace, 'feat: second isolated task');

    expect(readFileSync(join(firstWorkspace.workspacePath, 'tracked.txt'), 'utf8')).toBe('first task\n');
    expect(readFileSync(join(secondWorkspace.workspacePath, 'tracked.txt'), 'utf8')).toBe('second task\n');
    expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(firstWorkspace.workspacePath).not.toBe(secondWorkspace.workspacePath);
  });

  it('does not carry dirty files from the current branch into a different planned source branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-source-branch-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const workbench = join(root, 'workbench');
    git(repository, 'checkout', '-b', 'feature-source');
    writeFileSync(join(repository, 'feature.txt'), 'feature source\n');
    git(repository, 'add', 'feature.txt');
    git(repository, 'commit', '-m', 'feature source');
    const sourceCommit = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'checkout', 'master');
    writeFileSync(join(repository, 'tracked.txt'), 'dirty master\n');

    const project = projectFixture(repository);
    project.directories[0]?.localBranches.push('feature-source');
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const route = task.plan?.branchRoutes[0];
    if (!route) throw new Error('route missing');
    route.sourceBranch = 'feature-source';
    route.sourceCommit = sourceCommit;
    const manager = new GitWorkspaceManager(workbench);
    const [workspace] = manager.prepare(task, project);

    expect(readFileSync(join(workspace?.workspacePath ?? '', 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(readFileSync(join(workspace?.workspacePath ?? '', 'feature.txt'), 'utf8')).toBe('feature source\n');
    expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('dirty master\n');
  });

  it('rejects local source drift that happened after plan confirmation', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-source-drift-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const project = projectFixture(repository);
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const route = task.plan?.branchRoutes[0];
    if (!route) throw new Error('route missing');
    route.sourceWorkingTreeHash = workingTreeFingerprint(repository);
    writeFileSync(join(repository, 'tracked.txt'), 'changed after confirmation\n');

    const manager = new GitWorkspaceManager(join(root, 'workbench'));
    expect(() => manager.prepare(task, project)).toThrow('计划确认后发生了新的本地变化');
    expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('changed after confirmation\n');
    expect(git(repository, 'status', '--porcelain=v1')).toContain('tracked.txt');
  });

  it('reports logical conflicts without changing the target branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-conflict-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const workbench = join(root, 'workbench');
    const project = projectFixture(repository);
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const manager = new GitWorkspaceManager(workbench);
    const [workspace] = manager.prepare(task, project);
    if (!workspace) throw new Error('workspace missing');
    writeFileSync(join(workspace.workspacePath, 'tracked.txt'), 'task version\n');
    manager.checkpoint(workspace, 'feat: task version');

    writeFileSync(join(repository, 'tracked.txt'), 'target version\n');
    git(repository, 'add', 'tracked.txt');
    git(repository, 'commit', '-m', 'target changed');
    const targetCommit = git(repository, 'rev-parse', 'HEAD');

    expect(() => manager.mergeToTargets(task, project, [workspace])).toThrow('语义冲突');
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(targetCommit);
    expect(readFileSync(join(repository, 'tracked.txt'), 'utf8')).toBe('target version\n');
    expect(git(repository, 'status', '--porcelain=v1')).toBe('');
  });

  it('automatically combines independent insertions at the same anchor and records the mechanical resolution', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-mechanical-conflict-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    writeFileSync(join(repository, 'list.txt'), 'start\nend\n');
    git(repository, 'add', 'list.txt');
    git(repository, 'commit', '-m', 'add list');
    const workbench = join(root, 'workbench');
    const project = projectFixture(repository);
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    if (!task.plan) throw new Error('plan missing');
    const route = task.plan.branchRoutes[0];
    if (!route) throw new Error('route missing');
    task.plan.branchRoutes[0] = {
      ...route,
      sourceCommit: git(repository, 'rev-parse', 'HEAD'),
    };
    const manager = new GitWorkspaceManager(workbench);
    const [workspace] = manager.prepare(task, project);
    if (!workspace) throw new Error('workspace missing');
    writeFileSync(join(workspace.workspacePath, 'list.txt'), 'start\ntask item\nend\n');
    manager.checkpoint(workspace, 'feat: task insertion');

    writeFileSync(join(repository, 'list.txt'), 'start\ntarget item\nend\n');
    git(repository, 'add', 'list.txt');
    git(repository, 'commit', '-m', 'target insertion');

    const [result] = manager.mergeToTargets(task, project, [workspace]);
    expect(result?.mechanicallyResolvedFiles).toEqual(['list.txt']);
    expect(readFileSync(join(repository, 'list.txt'), 'utf8')).toContain('target item');
    expect(readFileSync(join(repository, 'list.txt'), 'utf8')).toContain('task item');
    expect(git(repository, 'status', '--porcelain=v1')).toBe('');
  });

  it('classifies approved, out-of-scope and sensitive file changes before checkpointing', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-scope-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const workbench = join(root, 'workbench');
    mkdirSync(join(repository, 'src'));
    mkdirSync(join(repository, 'docs'));
    writeFileSync(join(repository, 'src', 'base.ts'), 'export const base = true;\n');
    writeFileSync(join(repository, 'docs', 'base.md'), '# Base\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'add scopes');
    const project = projectFixture(repository);
    const task = taskFixture(project.id, project.directories[0]?.id ?? 'dir_test');
    const manager = new GitWorkspaceManager(workbench);
    const [workspace] = manager.prepare(task, project);
    if (!workspace) throw new Error('workspace missing');
    const baseCommit = manager.head(workspace);

    writeFileSync(join(workspace.workspacePath, 'src', 'feature.ts'), 'export const feature = true;\n');
    writeFileSync(join(workspace.workspacePath, 'docs', 'unexpected.md'), '# Unexpected\n');
    writeFileSync(join(workspace.workspacePath, '.env.local'), 'TOKEN=secret\n');
    const inspection = manager.inspectChanges(workspace, baseCommit, ['src'], []);

    expect(inspection.files.find((file) => file.path === 'src/feature.ts')?.inApprovedScope).toBe(true);
    expect(inspection.files.find((file) => file.path === 'docs/unexpected.md')?.inApprovedScope).toBe(false);
    expect(inspection.files.find((file) => file.path === '.env.local')?.sensitive).toBe(true);
    expect(inspection.hasOutOfScopeChanges).toBe(true);
    expect(inspection.hasSensitiveChanges).toBe(true);
  });

  it('compensates earlier merges when a later directory in the same repository conflicts', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-atomic-merge-test-'));
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    writeFileSync(join(repository, 'shared.txt'), 'base\n');
    git(repository, 'add', 'shared.txt');
    git(repository, 'commit', '-m', 'shared base');
    const originalTarget = git(repository, 'rev-parse', 'HEAD');
    const workbench = join(root, 'workbench');
    const project = projectFixture(repository);
    const firstDirectory = project.directories[0];
    if (!firstDirectory) throw new Error('directory missing');
    const secondDirectory = { ...firstDirectory, id: 'dir_second', displayName: 'repository-second' };
    project.directories.push(secondDirectory);
    const task = taskFixture(project.id, firstDirectory.id);
    if (!task.plan) throw new Error('plan missing');
    task.plan.branchRoutes.push({
      directoryId: secondDirectory.id,
      sourceBranch: 'master',
      sourceCommit: originalTarget,
      taskBranch: 'yanxu/test-second',
      targetBranch: 'master',
    });
    const manager = new GitWorkspaceManager(workbench);
    const workspaces = manager.prepare(task, project);
    const firstWorkspace = workspaces.find((item) => item.directoryId === firstDirectory.id);
    const secondWorkspace = workspaces.find((item) => item.directoryId === secondDirectory.id);
    if (!firstWorkspace || !secondWorkspace) throw new Error('workspaces missing');
    writeFileSync(join(firstWorkspace.workspacePath, 'shared.txt'), 'first task\n');
    manager.checkpoint(firstWorkspace, 'feat: first task');
    writeFileSync(join(secondWorkspace.workspacePath, 'shared.txt'), 'second task\n');
    manager.checkpoint(secondWorkspace, 'feat: second task');

    expect(() => manager.mergeToTargets(task, project, workspaces)).toThrow('冲突');
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(originalTarget);
    expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('base\n');
    expect(git(repository, 'status', '--porcelain=v1')).toBe('');
  });
});

function createRepository(root: string): string {
  const repository = join(root, 'repository');
  mkdirSync(repository);
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Test');
  git(repository, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repository, 'tracked.txt'), 'base\n');
  git(repository, 'add', 'tracked.txt');
  git(repository, 'commit', '-m', 'initial');
  return repository;
}

function projectFixture(repository: string): Project {
  const timestamp = new Date().toISOString();
  return {
    id: 'prj_test', name: 'Test', description: '', projectSpacePath: join(repository, '.projectspace'),
    createdAt: timestamp, updatedAt: timestamp, taskSummary: { active: 0, attention: 0, delivered: 0, archived: 0 },
    directories: [{
      id: 'dir_test', projectId: 'prj_test', displayName: 'repository', selectedPath: repository, realPath: repository,
      gitRootPath: repository, gitInitialized: true, currentBranch: git(repository, 'branch', '--show-current'), isDirty: true,
      contentTypes: ['代码'], stack: [], commands: {}, localBranches: ['master'], scannedAt: timestamp,
    }],
  };
}

function taskFixture(projectId: string, directoryId: string): Task {
  const timestamp = new Date().toISOString();
  return {
    id: 'task_test1234567890', projectId, projectName: 'Test', teamId: 'team_test', teamName: 'Test', title: 'Test task',
    description: 'Test', expectedOutput: '', constraints: '', forbiddenPaths: [], status: 'PREPARING', stateVersion: 1,
    progress: 0, activeStepId: null, createdAt: timestamp, updatedAt: timestamp, steps: [], snapshot: null,
    plan: {
      id: 'plan_test', taskId: 'task_test1234567890', version: 1,
      taskVersionId: 'taskv_test', taskVersion: 1, preApprovalSkillIds: [],
      goal: 'Test', scope: ['repository'], nonScope: [],
      successCriteria: [], assumptions: [], risks: [], questions: [], permissions: [], qualityGates: [],
      preApprovalArtifacts: [],
      answersReviewedAt: null, createdAt: timestamp, confirmedAt: timestamp,
      steps: [],
      branchRoutes: [{ directoryId, sourceBranch: 'master', sourceCommit: 'HEAD', taskBranch: 'yanxu/test', targetBranch: 'master' }],
    },
  };
}

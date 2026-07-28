import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ChangeManifestFile, Project, Task } from '@yanxu/contracts';
import { DomainError } from './errors.js';

export interface PreparedWorkspace {
  taskId: string;
  directoryId: string;
  workspacePath: string;
  scopePath: string;
  baselineCommit: string;
  taskBranch: string;
  targetBranch: string;
}

export interface MergeResult {
  directoryId: string;
  repositoryPath: string;
  taskBranch: string;
  targetBranch: string;
  previousTargetCommit: string;
  mergedCommit: string;
  alreadyMerged: boolean;
  mechanicallyResolvedFiles: string[];
}

export interface TargetValidationWorkspace extends PreparedWorkspace {
  repositoryPath: string;
  temporary: boolean;
}

export interface GitChangeInspection {
  directoryId: string;
  baseCommit: string;
  files: ChangeManifestFile[];
  hasOutOfScopeChanges: boolean;
  hasSensitiveChanges: boolean;
}

interface MergeCandidate {
  workspace: PreparedWorkspace;
  repositoryPath: string;
  taskCommit: string;
  targetCommit: string;
  targetWorktreePath: string | null;
  alreadyMerged: boolean;
  mechanicallyResolvedFiles: string[];
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function git(repository: string, args: string[], environment?: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', timeout: 60_000, env: environment ? { ...process.env, ...environment } : process.env,
  });
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function requireGit(repository: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  const result = git(repository, args, environment);
  if (result.status !== 0) throw new DomainError('GIT_COMMAND_FAILED', result.stderr || `git ${args.join(' ')} failed.`, 422, { repository, args });
  return result.stdout;
}

export class GitWorkspaceManager {
  constructor(private readonly workbenchHome: string) {}

  prepare(task: Task, project: Project): PreparedWorkspace[] {
    const root = join(this.workbenchHome, 'runtime', 'tasks', task.id, 'workspace');
    mkdirSync(root, { recursive: true });
    const routes = task.plan?.branchRoutes ?? [];
    if (routes.length === 0) throw new DomainError('TASK_BRANCH_ROUTES_REQUIRED', '任务计划没有可执行的项目目录与分支路由。', 409);
    return routes.map((route) => {
      const directory = project.directories.find((item) => item.id === route.directoryId);
      if (!directory) throw new DomainError('TASK_DIRECTORY_MISSING', '任务计划引用的项目目录不存在。', 409, { directoryId: route.directoryId });
      const repository = directory.gitRootPath ?? directory.realPath;
      const workspacePath = join(root, directory.id);
      const existing = git(workspacePath, ['rev-parse', '--show-toplevel']);
      if (existing.status === 0) {
        const existingBranch = requireGit(workspacePath, ['branch', '--show-current']);
        if (existingBranch === `${route.taskBranch}-${directory.id.slice(4, 10)}`) {
          return {
            taskId: task.id, directoryId: directory.id, workspacePath,
            scopePath: workspaceScopePath(workspacePath, directory.gitRootPath ?? directory.realPath, directory.realPath),
            baselineCommit: requireGit(workspacePath, ['rev-parse', 'HEAD']),
            taskBranch: existingBranch,
            targetBranch: route.targetBranch,
          };
        }
        if (git(workspacePath, ['status', '--porcelain=v1']).stdout) {
          throw new DomainError(
            'GIT_STALE_WORKSPACE_DIRTY',
            `目录 ${directory.displayName} 的上一轮任务工作区仍有未提交修改，不能自动切换到新的任务分支。`,
            409,
            { directoryId: directory.id, workspacePath, existingBranch, requestedBranch: route.taskBranch },
          );
        }
        requireGit(repository, ['worktree', 'remove', workspacePath]);
      }

      const currentBranch = requireGit(repository, ['branch', '--show-current']);
      const plannedSourceCommit = route.sourceCommit === 'UNBORN'
        ? requireGit(repository, ['rev-parse', 'HEAD'])
        : requireGit(repository, ['rev-parse', route.sourceCommit]);
      const includeWorkingTree = route.sourceBranch === currentBranch;
      if (includeWorkingTree && route.sourceWorkingTreeHash) {
        const currentWorkingTreeHash = workingTreeFingerprint(repository);
        if (currentWorkingTreeHash !== route.sourceWorkingTreeHash) {
          throw new DomainError(
            'GIT_SOURCE_DRIFT',
            `目录 ${directory.displayName} 在计划确认后发生了新的本地变化，需要重新确认任务基线。`,
            409,
            {
              directoryId: directory.id,
              sourceBranch: route.sourceBranch,
              expectedWorkingTreeHash: route.sourceWorkingTreeHash,
              currentWorkingTreeHash,
            },
          );
        }
      }
      const baselineCommit = includeWorkingTree
        ? this.createSnapshotCommit(repository, task.id, directory.id, plannedSourceCommit)
        : this.pinBaselineCommit(repository, task.id, directory.id, plannedSourceCommit);
      const requestedBranch = route.taskBranch;
      const taskBranch = `${requestedBranch}-${directory.id.slice(4, 10)}`;
      const branchExists = git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${taskBranch}`]).status === 0;
      const args = branchExists
        ? ['worktree', 'add', workspacePath, taskBranch]
        : ['worktree', 'add', '-b', taskBranch, workspacePath, baselineCommit];
      requireGit(repository, args);
      return {
        taskId: task.id,
        directoryId: directory.id,
        workspacePath,
        scopePath: workspaceScopePath(workspacePath, repository, directory.realPath),
        baselineCommit,
        taskBranch,
        targetBranch: route.targetBranch,
      };
    });
  }

  checkpoint(workspace: PreparedWorkspace, message: string): string {
    requireGit(workspace.workspacePath, ['add', '-A']);
    const staged = git(workspace.workspacePath, ['diff', '--cached', '--quiet']);
    if (staged.status !== 0) {
      requireGit(workspace.workspacePath, ['-c', 'user.name=Yanxu', '-c', 'user.email=yanxu@local', 'commit', '-m', message]);
    }
    return requireGit(workspace.workspacePath, ['rev-parse', 'HEAD']);
  }

  head(workspace: PreparedWorkspace): string {
    return requireGit(workspace.workspacePath, ['rev-parse', 'HEAD']);
  }

  discardUnapprovedAttempt(workspace: PreparedWorkspace, baseCommit: string): void {
    requireGit(workspace.workspacePath, ['reset', '--hard', baseCommit]);
    requireGit(workspace.workspacePath, ['clean', '-fd']);
  }

  inspectChanges(
    workspace: PreparedWorkspace,
    baseCommit: string,
    allowedPrefixes: string[],
    forbiddenPaths: string[],
  ): GitChangeInspection {
    const normalizedAllowed = allowedPrefixes.map(normalizeRepositoryPath);
    const normalizedForbidden = forbiddenPaths.map(normalizeRepositoryPath).filter(Boolean);
    const entries = new Map<string, { status: ChangeManifestFile['status']; previousPath: string | null }>();
    const nameStatus = requireGit(workspace.workspacePath, ['diff', '--name-status', '--find-renames', baseCommit]);
    for (const line of nameStatus.split('\n').filter(Boolean)) {
      const [rawStatus = '', first = '', second] = line.split('\t');
      const renamed = rawStatus.startsWith('R');
      const path = normalizeRepositoryPath(renamed ? second ?? first : first);
      if (!path) continue;
      entries.set(path, {
        status: renamed ? 'renamed' : rawStatus.startsWith('A') ? 'added' : rawStatus.startsWith('D') ? 'deleted' : 'modified',
        previousPath: renamed ? normalizeRepositoryPath(first) : null,
      });
    }
    const untracked = requireGit(workspace.workspacePath, ['ls-files', '--others', '--exclude-standard']);
    for (const rawPath of untracked.split('\n').filter(Boolean)) {
      const path = normalizeRepositoryPath(rawPath);
      if (path && !entries.has(path)) entries.set(path, { status: 'added', previousPath: null });
    }
    const statistics = new Map<string, { addedLines: number | null; deletedLines: number | null }>();
    const numstat = requireGit(workspace.workspacePath, ['diff', '--numstat', baseCommit]);
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [added = '-', deleted = '-', rawPath = ''] = line.split('\t');
      const path = normalizeRepositoryPath(rawPath.includes(' => ') ? rawPath.slice(rawPath.lastIndexOf(' => ') + 4).replace(/[{}]/g, '') : rawPath);
      statistics.set(path, {
        addedLines: added === '-' ? null : Number(added),
        deletedLines: deleted === '-' ? null : Number(deleted),
      });
    }
    const files = [...entries.entries()].map(([path, entry]) => {
      const oldPath = entry.previousPath ?? path;
      const oldBlob = entry.status === 'added' ? null : git(workspace.workspacePath, ['rev-parse', `${baseCommit}:${oldPath}`]).stdout || null;
      const newBlob = entry.status === 'deleted' ? null : git(workspace.workspacePath, ['hash-object', '--', path]).stdout || null;
      const stats = statistics.get(path) ?? { addedLines: null, deletedLines: null };
      const inApprovedScope = isWithinAnyPrefix(path, normalizedAllowed)
        && !isWithinAnyPrefix(path, normalizedForbidden);
      return {
        path,
        previousPath: entry.previousPath,
        status: entry.status,
        oldBlob,
        newBlob,
        addedLines: stats.addedLines,
        deletedLines: stats.deletedLines,
        inApprovedScope,
        sensitive: isSensitivePath(path),
      } satisfies ChangeManifestFile;
    }).sort((a, b) => a.path.localeCompare(b.path));
    return {
      directoryId: workspace.directoryId,
      baseCommit,
      files,
      hasOutOfScopeChanges: files.some((file) => !file.inApprovedScope),
      hasSensitiveChanges: files.some((file) => file.sensitive),
    };
  }

  changedFiles(workspace: PreparedWorkspace): string[] {
    const output = requireGit(workspace.workspacePath, ['diff', '--name-only', `${workspace.baselineCommit}...HEAD`]);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  diff(workspace: PreparedWorkspace, path: string, maxCharacters = 400_000): { diff: string; truncated: boolean } {
    const normalized = normalizeRepositoryPath(path);
    if (!normalized || normalized.startsWith('../') || normalized === '..') {
      throw new DomainError('GIT_DIFF_PATH_INVALID', 'Diff 文件路径不合法。', 422, { path });
    }
    const output = requireGit(workspace.workspacePath, [
      'diff',
      '--no-ext-diff',
      '--unified=60',
      workspace.baselineCommit,
      'HEAD',
      '--',
      normalized,
    ]);
    return {
      diff: output.slice(0, maxCharacters),
      truncated: output.length > maxCharacters,
    };
  }

  mergeToTargets(task: Task, project: Project, workspaces: PreparedWorkspace[]): MergeResult[] {
    const workspaceByDirectory = new Map(workspaces.map((workspace) => [workspace.directoryId, workspace]));
    const involvedDirectoryIds = new Set(task.plan?.branchRoutes.map((route) => route.directoryId) ?? []);
    const candidates = project.directories.filter((directory) => involvedDirectoryIds.has(directory.id)).map((directory) => {
      const workspace = workspaceByDirectory.get(directory.id);
      if (!workspace) throw new DomainError('TASK_WORKSPACE_MISSING', `目录 ${directory.displayName} 缺少任务工作区。`, 409);
      const repositoryPath = directory.gitRootPath ?? directory.realPath;
      const taskCommit = requireGit(repositoryPath, ['rev-parse', '--verify', `refs/heads/${workspace.taskBranch}`]);
      const targetCommit = requireGit(repositoryPath, ['rev-parse', '--verify', `refs/heads/${workspace.targetBranch}`]);
      const targetWorktreePath = this.findBranchWorktree(repositoryPath, workspace.targetBranch);
      if (targetWorktreePath && git(targetWorktreePath, ['status', '--porcelain=v1']).stdout) {
        throw new DomainError('GIT_TARGET_DIRTY', `目标分支 ${workspace.targetBranch} 所在工作区存在未提交修改，研序不会覆盖这些内容。`, 409, {
          directoryId: directory.id, targetBranch: workspace.targetBranch, worktreePath: targetWorktreePath,
        });
      }
      return {
        workspace, repositoryPath, taskCommit, targetCommit, targetWorktreePath,
        alreadyMerged: git(repositoryPath, ['merge-base', '--is-ancestor', taskCommit, targetCommit]).status === 0,
        mechanicallyResolvedFiles: [] as string[],
      } satisfies MergeCandidate;
    });

    for (const candidate of candidates) {
      candidate.mechanicallyResolvedFiles = this.preflightMerge(task.id, candidate);
    }
    for (const candidate of candidates) {
      const currentTarget = requireGit(candidate.repositoryPath, ['rev-parse', '--verify', `refs/heads/${candidate.workspace.targetBranch}`]);
      if (currentTarget !== candidate.targetCommit) {
        throw new DomainError('GIT_TARGET_MOVED', `目标分支 ${candidate.workspace.targetBranch} 在合并检查后发生了变化，请重新确认交付。`, 409, {
          directoryId: candidate.workspace.directoryId, expected: candidate.targetCommit, actual: currentTarget,
        });
      }
      requireGit(candidate.repositoryPath, [
        'update-ref',
        `refs/yanxu/delivery-safety/${task.id}/${candidate.workspace.directoryId}`,
        candidate.targetCommit,
      ]);
    }

    const applied: Array<{ candidate: MergeCandidate; result: MergeResult }> = [];
    try {
      for (const candidate of candidates) {
        applied.push({ candidate, result: this.applyMerge(task.id, candidate) });
      }
      return applied.map((item) => item.result);
    } catch (error) {
      const rollbackFailures: Array<{ directoryId: string; reason: string }> = [];
      for (const item of applied.reverse()) {
        if (item.result.alreadyMerged) continue;
        try {
          this.rollbackAppliedMerge(item.candidate, item.result);
        } catch (rollbackError) {
          rollbackFailures.push({
            directoryId: item.result.directoryId,
            reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
      }
      if (rollbackFailures.length > 0) {
        throw new DomainError(
          'GIT_MERGE_PARTIAL_ROLLBACK',
          '多目录交付失败，且部分已应用合并无法安全回滚，需要人工依据 safety ref 处理。',
          409,
          {
            originalError: error instanceof Error ? error.message : String(error),
            rollbackFailures,
          },
        );
      }
      throw error;
    }
  }

  prepareTargetValidationWorkspaces(
    taskId: string,
    project: Project,
    results: MergeResult[],
  ): TargetValidationWorkspace[] {
    const prepared: TargetValidationWorkspace[] = [];
    try {
      for (const result of results) {
        const directory = project.directories.find((item) => item.id === result.directoryId);
        if (!directory) {
          throw new DomainError('TASK_DIRECTORY_MISSING', '合并后验证引用的项目目录不存在。', 409, {
            directoryId: result.directoryId,
          });
        }
        prepared.push(this.prepareDetachedValidationWorkspace({
          taskId,
          directory,
          repositoryPath: result.repositoryPath,
          commit: result.mergedCommit,
          baselineCommit: result.previousTargetCommit,
          taskBranch: result.taskBranch,
          targetBranch: result.targetBranch,
          phase: 'merge-validation',
        }));
      }
      return prepared;
    } catch (error) {
      this.cleanupTargetValidationWorkspaces(prepared);
      throw error;
    }
  }

  prepareTaskValidationWorkspaces(
    taskId: string,
    project: Project,
    taskWorkspaces: PreparedWorkspace[],
  ): TargetValidationWorkspace[] {
    const prepared: TargetValidationWorkspace[] = [];
    try {
      for (const workspace of taskWorkspaces) {
        const directory = project.directories.find((item) => item.id === workspace.directoryId);
        if (!directory) {
          throw new DomainError('TASK_DIRECTORY_MISSING', '质量门禁引用的项目目录不存在。', 409, {
            directoryId: workspace.directoryId,
          });
        }
        const repositoryPath = directory.gitRootPath ?? directory.realPath;
        prepared.push(this.prepareDetachedValidationWorkspace({
          taskId,
          directory,
          repositoryPath,
          commit: this.head(workspace),
          baselineCommit: workspace.baselineCommit,
          taskBranch: workspace.taskBranch,
          targetBranch: workspace.targetBranch,
          phase: 'gate-validation',
        }));
      }
      return prepared;
    } catch (error) {
      this.cleanupTargetValidationWorkspaces(prepared);
      throw error;
    }
  }

  cleanupTargetValidationWorkspaces(workspaces: TargetValidationWorkspace[]): void {
    for (const workspace of workspaces) {
      if (workspace.temporary) this.removeTemporaryWorktree(workspace.repositoryPath, workspace.workspacePath);
    }
  }

  rollbackMergeResults(
    project: Project,
    taskWorkspaces: PreparedWorkspace[],
    results: MergeResult[],
  ): void {
    const workspaceByDirectory = new Map(taskWorkspaces.map((workspace) => [workspace.directoryId, workspace]));
    const failures: Array<{ directoryId: string; reason: string }> = [];
    for (const result of [...results].reverse()) {
      if (result.alreadyMerged) continue;
      const workspace = workspaceByDirectory.get(result.directoryId);
      const directory = project.directories.find((item) => item.id === result.directoryId);
      if (!workspace || !directory) {
        failures.push({ directoryId: result.directoryId, reason: '任务工作区或项目目录不存在。' });
        continue;
      }
      const candidate: MergeCandidate = {
        workspace,
        repositoryPath: result.repositoryPath,
        taskCommit: result.mergedCommit,
        targetCommit: result.previousTargetCommit,
        targetWorktreePath: this.findBranchWorktree(result.repositoryPath, result.targetBranch),
        alreadyMerged: false,
        mechanicallyResolvedFiles: result.mechanicallyResolvedFiles,
      };
      try {
        this.rollbackAppliedMerge(candidate, result);
      } catch (error) {
        failures.push({
          directoryId: result.directoryId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length > 0) {
      throw new DomainError(
        'GIT_POST_MERGE_ROLLBACK_FAILED',
        '合并后验证失败，且部分目标分支无法安全恢复，需要人工依据 delivery-safety ref 处理。',
        409,
        { failures },
      );
    }
  }

  private prepareDetachedValidationWorkspace(input: {
    taskId: string;
    directory: Project['directories'][number];
    repositoryPath: string;
    commit: string;
    baselineCommit: string;
    taskBranch: string;
    targetBranch: string;
    phase: 'gate-validation' | 'merge-validation';
  }): TargetValidationWorkspace {
    const temporaryPath = join(
      this.workbenchHome,
      'runtime',
      'tasks',
      input.taskId,
      input.phase,
      input.directory.id,
    );
    this.removeTemporaryWorktree(input.repositoryPath, temporaryPath);
    requireGit(input.repositoryPath, ['worktree', 'add', '--detach', temporaryPath, input.commit]);
    if (requireGit(temporaryPath, ['rev-parse', 'HEAD']) !== input.commit) {
      this.removeTemporaryWorktree(input.repositoryPath, temporaryPath);
      throw new DomainError('GIT_VALIDATION_TARGET_MOVED', '验证工作区未固定在预期提交。', 409, {
        directoryId: input.directory.id,
        expectedCommit: input.commit,
      });
    }
    return {
      taskId: input.taskId,
      directoryId: input.directory.id,
      repositoryPath: input.repositoryPath,
      workspacePath: temporaryPath,
      scopePath: workspaceScopePath(temporaryPath, input.repositoryPath, input.directory.realPath),
      baselineCommit: input.baselineCommit,
      taskBranch: input.taskBranch,
      targetBranch: input.targetBranch,
      temporary: true,
    };
  }

  private preflightMerge(taskId: string, candidate: MergeCandidate): string[] {
    if (candidate.alreadyMerged) return [];
    const path = join(this.workbenchHome, 'runtime', 'tasks', taskId, 'merge-preflight', candidate.workspace.directoryId);
    this.removeTemporaryWorktree(candidate.repositoryPath, path);
    requireGit(candidate.repositoryPath, ['worktree', 'add', '--detach', path, candidate.targetCommit]);
    try {
      const result = git(path, ['merge', '--no-commit', '--no-ff', candidate.workspace.taskBranch]);
      if (result.status !== 0) {
        const resolution = this.resolveMechanicalConflicts(path);
        if (resolution.unresolved.length === 0) {
          git(path, ['merge', '--abort']);
          return resolution.resolved;
        }
        git(path, ['merge', '--abort']);
        throw new DomainError('GIT_SEMANTIC_CONFLICT', '任务分支与目标分支存在语义冲突，需要用户决定。', 409, {
          directoryId: candidate.workspace.directoryId,
          taskBranch: candidate.workspace.taskBranch,
          targetBranch: candidate.workspace.targetBranch,
          classification: 'semantic',
          conflicts: resolution.unresolved,
          mechanicallyResolvableFiles: resolution.resolved,
        });
      }
      git(path, ['merge', '--abort']);
      return [];
    } finally {
      this.removeTemporaryWorktree(candidate.repositoryPath, path);
    }
  }

  private applyMerge(taskId: string, candidate: MergeCandidate): MergeResult {
    if (candidate.alreadyMerged) {
      const currentTarget = requireGit(candidate.repositoryPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${candidate.workspace.targetBranch}`,
      ]);
      return {
        directoryId: candidate.workspace.directoryId,
        repositoryPath: candidate.repositoryPath,
        taskBranch: candidate.workspace.taskBranch,
        targetBranch: candidate.workspace.targetBranch,
        previousTargetCommit: currentTarget,
        mergedCommit: currentTarget,
        alreadyMerged: true,
        mechanicallyResolvedFiles: [],
      };
    }

    const temporaryPath = join(this.workbenchHome, 'runtime', 'tasks', taskId, 'merge-apply', candidate.workspace.directoryId);
    const mergePath = candidate.targetWorktreePath ?? temporaryPath;
    if (!candidate.targetWorktreePath) {
      this.removeTemporaryWorktree(candidate.repositoryPath, temporaryPath);
      requireGit(candidate.repositoryPath, ['worktree', 'add', temporaryPath, candidate.workspace.targetBranch]);
    }
    try {
      const previousTargetCommit = requireGit(mergePath, ['rev-parse', 'HEAD']);
      const result = git(mergePath, [
        '-c', 'user.name=Yanxu', '-c', 'user.email=yanxu@local',
        'merge', '--no-ff', '--no-edit', candidate.workspace.taskBranch,
      ]);
      if (result.status !== 0) {
        const resolution = this.resolveMechanicalConflicts(mergePath);
        if (resolution.unresolved.length > 0) {
          git(mergePath, ['merge', '--abort']);
          throw new DomainError('GIT_SEMANTIC_CONFLICT', '应用合并时检测到语义冲突，已中止且保留任务分支。', 409, {
            directoryId: candidate.workspace.directoryId,
            taskBranch: candidate.workspace.taskBranch,
            targetBranch: candidate.workspace.targetBranch,
            classification: 'semantic',
            conflicts: resolution.unresolved,
            mechanicallyResolvableFiles: resolution.resolved,
          });
        }
        requireGit(mergePath, [
          '-c', 'user.name=Yanxu', '-c', 'user.email=yanxu@local',
          'commit', '--no-edit',
        ]);
        candidate.mechanicallyResolvedFiles = resolution.resolved;
      }
      return {
        directoryId: candidate.workspace.directoryId,
        repositoryPath: candidate.repositoryPath,
        taskBranch: candidate.workspace.taskBranch,
        targetBranch: candidate.workspace.targetBranch,
        previousTargetCommit,
        mergedCommit: requireGit(mergePath, ['rev-parse', 'HEAD']),
        alreadyMerged: false,
        mechanicallyResolvedFiles: candidate.mechanicallyResolvedFiles,
      };
    } finally {
      if (!candidate.targetWorktreePath) this.removeTemporaryWorktree(candidate.repositoryPath, temporaryPath);
    }
  }

  private resolveMechanicalConflicts(worktreePath: string): {
    resolved: string[];
    unresolved: Array<{ path: string; reason: string; hunkCount: number }>;
  } {
    const conflicts = git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    const resolved: string[] = [];
    const unresolved: Array<{ path: string; reason: string; hunkCount: number }> = [];
    for (const path of conflicts) {
      const hasBase = git(worktreePath, ['cat-file', '-e', `:1:${path}`]).status === 0;
      const checkout = git(worktreePath, ['checkout', '--conflict=diff3', '--', path]);
      if (checkout.status !== 0) {
        unresolved.push({ path, reason: 'non_text_conflict', hunkCount: 0 });
        continue;
      }
      const content = readFileSync(join(worktreePath, path));
      if (content.includes(0)) {
        unresolved.push({ path, reason: 'binary_conflict', hunkCount: 0 });
        continue;
      }
      const resolution = resolveDiff3Text(content.toString('utf8'), hasBase);
      if (resolution.content === null) {
        unresolved.push({
          path,
          reason: resolution.reason ?? 'overlapping_changes',
          hunkCount: resolution.hunkCount,
        });
        continue;
      }
      writeFileSync(join(worktreePath, path), resolution.content, { encoding: 'utf8' });
      requireGit(worktreePath, ['add', '--', path]);
      resolved.push(path);
    }
    return { resolved, unresolved };
  }

  private rollbackAppliedMerge(candidate: MergeCandidate, result: MergeResult): void {
    const currentTarget = requireGit(candidate.repositoryPath, [
      'rev-parse',
      '--verify',
      `refs/heads/${candidate.workspace.targetBranch}`,
    ]);
    if (currentTarget !== result.mergedCommit) {
      throw new DomainError(
        'GIT_ROLLBACK_TARGET_MOVED',
        `目标分支 ${candidate.workspace.targetBranch} 在补偿前又发生变化，研序不会覆盖外部提交。`,
        409,
        { expected: result.mergedCommit, actual: currentTarget },
      );
    }
    if (candidate.targetWorktreePath) {
      if (git(candidate.targetWorktreePath, ['status', '--porcelain=v1']).stdout) {
        throw new DomainError(
          'GIT_ROLLBACK_TARGET_DIRTY',
          `目标工作区 ${candidate.targetWorktreePath} 在补偿前出现新修改，研序不会执行 hard reset。`,
          409,
        );
      }
      requireGit(candidate.targetWorktreePath, ['reset', '--hard', result.previousTargetCommit]);
      return;
    }
    requireGit(candidate.repositoryPath, [
      'update-ref',
      `refs/heads/${candidate.workspace.targetBranch}`,
      result.previousTargetCommit,
      result.mergedCommit,
    ]);
  }

  private findBranchWorktree(repository: string, branch: string): string | null {
    const output = requireGit(repository, ['worktree', 'list', '--porcelain']);
    for (const block of output.split(/\n\n+/)) {
      const lines = block.split('\n');
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      const checkedOutBranch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      if (path && checkedOutBranch === `refs/heads/${branch}`) return path;
    }
    return null;
  }

  private removeTemporaryWorktree(repository: string, path: string): void {
    git(repository, ['worktree', 'remove', '--force', path]);
    rmSync(path, { recursive: true, force: true });
    git(repository, ['worktree', 'prune']);
  }

  private createSnapshotCommit(repository: string, taskId: string, directoryId: string, sourceCommit: string): string {
    const operationDirectory = join(this.workbenchHome, 'runtime', 'tasks', taskId, 'operation-journal');
    mkdirSync(operationDirectory, { recursive: true });
    const indexPath = join(operationDirectory, `${directoryId}.index`);
    rmSync(indexPath, { force: true });
    const environment = { GIT_INDEX_FILE: indexPath };
    requireGit(repository, ['read-tree', sourceCommit], environment);
    requireGit(repository, [
      'add', '-A', '--', '.',
      ':(exclude).env', ':(exclude).env.*', ':(exclude)*.pem', ':(exclude)*.key',
      ':(exclude)id_rsa*', ':(exclude).DS_Store',
      ':(exclude)**/.env', ':(exclude)**/.env.*', ':(exclude)**/*.pem', ':(exclude)**/*.key',
      ':(exclude)**/id_rsa*', ':(exclude)**/.DS_Store',
    ], environment);
    const tree = requireGit(repository, ['write-tree'], environment);
    const commitArgs = ['commit-tree', tree, '-m', `Yanxu baseline for ${taskId} (${basename(repository)})`];
    commitArgs.push('-p', sourceCommit);
    const commit = requireGit(repository, commitArgs, {
      ...environment,
      GIT_AUTHOR_NAME: 'Yanxu', GIT_AUTHOR_EMAIL: 'yanxu@local', GIT_COMMITTER_NAME: 'Yanxu', GIT_COMMITTER_EMAIL: 'yanxu@local',
    });
    requireGit(repository, ['update-ref', `refs/yanxu/baselines/${taskId}/${directoryId}`, commit]);
    rmSync(indexPath, { force: true });
    return commit;
  }

  private pinBaselineCommit(repository: string, taskId: string, directoryId: string, sourceCommit: string): string {
    requireGit(repository, ['update-ref', `refs/yanxu/baselines/${taskId}/${directoryId}`, sourceCommit]);
    return sourceCommit;
  }
}

function resolveDiff3Text(input: string, hasBase: boolean): {
  content: string | null;
  hunkCount: number;
  reason: string | null;
} {
  const marker = /^<<<<<<<[^\r\n]*\r?\n([\s\S]*?)^\|\|\|\|\|\|\|[^\r\n]*\r?\n([\s\S]*?)^=======[^\r\n]*\r?\n([\s\S]*?)^>>>>>>>[^\r\n]*(?:\r?\n|$)/gm;
  let hunkCount = 0;
  let semantic = false;
  const content = input.replace(marker, (_match, ours: string, base: string, theirs: string) => {
    hunkCount += 1;
    if (ours === theirs) return ours;
    if (sameIgnoringTrailingWhitespace(ours, theirs)) return ours;
    if (ours === base) return theirs;
    if (theirs === base) return ours;
    if (hasBase && base.trim() === '') return mergeInsertedText(ours, theirs);
    semantic = true;
    return _match;
  });
  if (hunkCount === 0) return { content: null, hunkCount: 0, reason: 'missing_diff3_markers' };
  if (semantic || /^<<<<<<<|^\|\|\|\|\|\|\||^=======|^>>>>>>>/m.test(content)) {
    return { content: null, hunkCount, reason: 'overlapping_non_additive_changes' };
  }
  return { content, hunkCount, reason: null };
}

function sameIgnoringTrailingWhitespace(left: string, right: string): boolean {
  const normalize = (value: string) => value.split(/\r?\n/).map((line) => line.trimEnd()).join('\n');
  return normalize(left) === normalize(right);
}

function mergeInsertedText(ours: string, theirs: string): string {
  const units = (value: string) => value.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const merged = units(ours);
  const known = new Set(merged.map((line) => line.trimEnd()));
  for (const line of units(theirs)) {
    const key = line.trimEnd();
    if (!known.has(key)) {
      merged.push(line);
      known.add(key);
    }
  }
  return merged.join('');
}

export function workingTreeFingerprint(repository: string): string {
  const status = requireGit(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = status.split('\0').filter(Boolean);
  const hash = createHash('sha256');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    const statusCode = entry.slice(0, 2);
    const path = normalizeRepositoryPath(entry.slice(3));
    if (!path || isSensitivePath(path)) {
      if (statusCode.includes('R') || statusCode.includes('C')) index += 1;
      continue;
    }
    hash.update(statusCode).update('\0').update(path).update('\0');
    const workingBlob = git(repository, ['hash-object', '--', path]);
    hash.update(workingBlob.status === 0 ? workingBlob.stdout : 'DELETED').update('\0');
    const indexEntry = git(repository, ['ls-files', '--stage', '--', path]);
    hash.update(indexEntry.status === 0 ? indexEntry.stdout : 'UNTRACKED').update('\0');
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const renamedPath = normalizeRepositoryPath(entries[index + 1] ?? '');
      hash.update(renamedPath).update('\0');
      index += 1;
    }
  }
  return hash.digest('hex');
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
}

function workspaceScopePath(workspacePath: string, repositoryPath: string, selectedPath: string): string {
  const prefix = relative(repositoryPath, selectedPath);
  return !prefix || prefix === '.' ? workspacePath : join(workspacePath, prefix);
}

function isWithinAnyPrefix(path: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  return prefixes.some((prefix) => !prefix || path === prefix || path.startsWith(`${prefix}/`));
}

function isSensitivePath(path: string): boolean {
  const name = path.toLowerCase();
  return /(^|\/)\.env(?:\.|$)/.test(name)
    || /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name)
    || /\.(pem|key|p12|pfx|jks)$/.test(name)
    || /(^|\/)(credentials|secrets?)(?:\.|\/|$)/.test(name);
}

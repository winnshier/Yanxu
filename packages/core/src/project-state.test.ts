import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { DomainError } from './errors.js';
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

describe('ProjectSpace state reconstruction', () => {
  it('restores project semantics and evidence into a fresh database without pretending to resume runtime state', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-project-state-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'repository');
    const firstWorkbench = join(root, 'first-workbench');
    const secondWorkbench = join(root, 'second-workbench');
    mkdirSync(projectDirectory);

    const firstDatabase = openDatabase(join(firstWorkbench, 'system', 'app.db'));
    const firstStore = new YanxuStore(firstDatabase, firstWorkbench);
    const developer = firstStore.createAgent({
      name: '恢复测试研发',
      roleId: 'development',
      executor: 'opencode',
      model: 'test-model',
      permissionMode: 'managed',
    }, availableOpenCode);
    const team = firstStore.createTeam({ name: '恢复测试团队', memberIds: [developer.id] });
    const project = firstStore.createProject({ name: '可重建项目', description: '原始说明', directoryPath: projectDirectory });
    firstStore.updateProjectSettings(project.id, {
      description: '可从 ProjectSpace 恢复',
      permissionMode: 'managed',
      forbiddenPaths: ['.env', 'secrets/**'],
    });
    const directoryId = project.directories[0]?.id ?? '';
    let task = firstStore.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '保留恢复证据',
      description: '创建需求、计划和运行快照。',
      expectedOutput: '可重建的项目状态',
    });
    const attachmentPath = join(root, 'restore-requirement.md');
    writeFileSync(attachmentPath, '# 恢复附件\n\n这份附件需要随 ProjectSpace 重建。\n');
    firstStore.attachTaskFiles(task.id, [attachmentPath]);
    task = firstStore.submitTask(task.id, task.stateVersion);
    task = firstStore.saveComposedPlan(task.id, {
      goal: '验证 ProjectSpace 重建',
      scope: ['repository'],
      nonScope: ['远程发布'],
      successCriteria: ['新数据库可读取同一任务和计划'],
      assumptions: [],
      risks: [],
      questions: [],
      permissions: ['读取和写入隔离工作区'],
      steps: [{
        id: 'restore-implementation',
        position: 0,
        unitKey: 'work-unit',
        agentId: developer.id,
        title: '形成恢复证据',
        description: '保留计划与快照。',
        inputs: ['任务需求'],
        expectedOutput: '实现摘要',
        directoryIds: [directoryId],
      }],
      qualityGates: [],
    });
    task = firstStore.commandTask(task.id, 'confirm', task.stateVersion);
    expect(task.status).toBe('PREPARING');
    const step = task.steps[0];
    if (!step) throw new Error('step missing');
    const sessionId = firstStore.createAgentSession(task.id, step, developer);
    firstStore.recordSessionFailure(sessionId, step.id, '保留一次可恢复的失败会话。');
    firstStore.recordDeliveryAction(task.id, 'merge_to_target', 'failed', {
      reason: '恢复测试证据',
    });
    const conflict = firstStore.recordDeliveryConflict(task.id, new DomainError(
      'GIT_SEMANTIC_CONFLICT',
      '测试语义冲突',
      409,
      {
        directoryId,
        taskBranch: 'yanxu/restore',
        targetBranch: 'main',
        conflicts: [{ path: 'src/feature.ts', reason: '同一逻辑发生重叠修改', hunkCount: 1 }],
      },
    ));
    firstDatabase.prepare(`
      INSERT INTO recovery_records(
        id, task_id, job_id, reason, previous_owner, recovered_by, action, created_at
      ) VALUES ('recovery_restore_test', ?, NULL, 'fixture', 'daemon_old', 'daemon_new', 'job_requeued', ?)
    `).run(task.id, new Date().toISOString());
    firstStore.refreshProjectSpaceState(project.id);
    expect(existsSync(join(project.projectSpacePath, 'state', 'current.json'))).toBe(true);
    const preview = firstStore.previewProjectSpaceRestore(project.projectSpacePath);
    expect(preview).toMatchObject({
      valid: true,
      projectId: project.id,
      counts: {
        directories: 1,
        teams: 1,
        agents: 1,
        tasks: 1,
        taskVersions: 1,
        plans: 1,
        snapshots: 1,
      },
    });
    firstDatabase.close();

    const secondDatabase = openDatabase(join(secondWorkbench, 'system', 'app.db'));
    const secondStore = new YanxuStore(secondDatabase, secondWorkbench);
    const restored = secondStore.restoreProjectSpace(project.projectSpacePath);
    expect(restored).toEqual({
      projectId: project.id,
      restoredTasks: 1,
      stoppedTaskIds: [task.id],
    });
    expect(secondStore.getProject(project.id)).toMatchObject({
      id: project.id,
      name: '可重建项目',
      description: '可从 ProjectSpace 恢复',
    });
    expect(secondStore.getProjectSettings(project.id)).toMatchObject({
      permissionMode: 'managed',
      forbiddenPaths: ['.env', 'secrets/**'],
    });
    const restoredTask = secondStore.getTask(task.id);
    expect(restoredTask).toMatchObject({
      status: 'STOPPED',
      title: task.title,
      plan: {
        id: task.plan?.id,
        taskVersionId: task.plan?.taskVersionId,
      },
    });
    expect(secondStore.getRunSnapshot(task.id)).toMatchObject({
      planId: task.plan?.id,
      taskVersion: { id: task.plan?.taskVersionId },
    });
    expect(secondStore.getTaskEvidence(task.id)).toMatchObject({
      sessions: [expect.objectContaining({
        id: sessionId,
        status: 'failed',
        error: '保留一次可恢复的失败会话。',
      })],
      deliveryActions: [expect.objectContaining({
        action: 'merge_to_target',
        status: 'failed',
      })],
      deliveryConflicts: [expect.objectContaining({
        id: conflict.id,
        status: 'pending',
      })],
      recoveries: [expect.objectContaining({
        id: 'recovery_restore_test',
        reason: 'fixture',
      })],
      attachments: [expect.objectContaining({
        fileName: 'restore-requirement.md',
        contentPreview: expect.stringContaining('随 ProjectSpace 重建'),
      })],
    });
    expect(secondStore.checkProjectSpaceIntegrity(project.id)).toMatchObject({
      status: 'healthy',
      issues: [],
    });
    expect(secondStore.dashboard([availableOpenCode]).attention).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
    expect(secondStore.getProject(project.id).taskSummary.attention).toBe(1);
    secondDatabase.close();
  }, 15_000);
});

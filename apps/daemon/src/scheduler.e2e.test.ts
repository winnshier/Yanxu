import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase, YanxuStore } from '@yanxu/core';
import type {
  ExecutorAdapter,
  RuntimeHandle,
  StructuredExecutionInput,
  StructuredExecutionResult,
} from '@yanxu/executors';
import { ExecutorRegistry } from './executor-registry.js';
import { Scheduler, type SkillResult } from './scheduler.js';

const temporaryDirectories: string[] = [];

const availableOpenCode: ExecutorInstallation = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  path: '/tmp/fake-opencode',
  version: 'test',
  health: 'available',
  capabilities: ['sessions', 'structured-output', 'permissions', 'abort'],
  models: ['test/fake'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

interface FakePlanConfiguration {
  directoryId: string;
  developerId: string;
  testerId?: string;
  reviewerId?: string;
  fullFlow: boolean;
  blockFirstImplementation?: boolean;
  failFirstImplementation?: boolean;
  delayFirstImplementation?: boolean;
}

class FakeOpenCodeAdapter implements ExecutorAdapter {
  private runtimeSequence = 0;
  private sessionSequence = 0;
  private implementationAttempts = 0;
  private readonly blocked = new Map<string, (error: Error) => void>();

  constructor(private readonly configuration: FakePlanConfiguration) {}

  get runtimeStartCount(): number {
    return this.runtimeSequence;
  }

  probe(): Promise<ExecutorInstallation> {
    return Promise.resolve(availableOpenCode);
  }

  startRuntime(workspacePath: string): Promise<RuntimeHandle> {
    this.runtimeSequence += 1;
    return Promise.resolve({
      id: `fake-runtime-${this.runtimeSequence}`,
      executor: 'opencode',
      workspacePath,
      endpoint: 'http://127.0.0.1/fake',
      sessionIds: [],
    });
  }

  async executeStructured<T>(input: StructuredExecutionInput): Promise<StructuredExecutionResult<T>> {
    this.sessionSequence += 1;
    const sessionId = `fake-session-${this.sessionSequence}`;
    input.runtime.sessionIds.push(sessionId);

    if (input.title.startsWith('确认前技能选择')) {
      return this.result<T>(sessionId, {
        skillIds: this.configuration.fullFlow ? ['requirement-specification'] : [],
        rationale: this.configuration.fullFlow ? '完整研发需要先形成可确认的需求规格。' : '恢复测试使用已明确的实施范围。',
      });
    }
    if (input.title.startsWith('需求规格')) {
      return this.result<T>(sessionId, skillResult(
        'requirement-spec',
        '# RequirementSpec\n\n## 成功标准\n\n- 功能可执行并通过自动化验证。',
        ['目标与成功标准可验证', '歧义已显式列出'],
      ));
    }
    if (input.title.startsWith('研序计划')) {
      return this.result<T>(sessionId, this.plan());
    }
    if (input.title.includes('技术方案')) {
      return this.result<T>(sessionId, skillResult(
        'technical-plan',
        '# Technical Plan\n\n在隔离分支新增 feature.txt。',
        ['列出影响范围', '列出验证路径'],
      ));
    }
    if (input.title.includes('内容实施')) {
      this.implementationAttempts += 1;
      if (this.configuration.delayFirstImplementation && this.implementationAttempts === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (this.configuration.failFirstImplementation && this.implementationAttempts === 1) {
        throw new Error('Injected executor runtime crash.');
      }
      if (this.configuration.blockFirstImplementation && this.implementationAttempts === 1) {
        await new Promise<never>((_resolve, reject) => {
          this.blocked.set(input.runtime.id, reject);
        });
      }
      writeFileSync(
        join(input.runtime.workspacePath, this.configuration.directoryId, 'feature.txt'),
        `implementation attempt ${this.implementationAttempts}\n`,
      );
      return this.result<T>(sessionId, skillResult(
        'implementation-report',
        '# Implementation\n\n已新增 feature.txt。',
        ['变更位于批准范围', '实际文件清单可由 Git 重建'],
      ));
    }
    if (input.title.includes('测试设计')) {
      const output = skillResult(
        'test-plan',
        '# Test Plan\n\n执行已批准基础门禁和关键场景。',
        ['覆盖成功标准', '标明豁免与风险'],
      );
      output.artifacts[0] = {
        type: 'test-plan',
        content: '# Test Plan\n\n执行已批准基础门禁和关键场景。',
        metadata: {
          qualityGates: [{
            name: 'critical acceptance',
            commandArgv: [process.execPath, '-e', 'process.exit(0)', '--', 'critical'],
            directoryId: this.configuration.directoryId,
            required: true,
            timeoutMs: 30_000,
            expectedExitCodes: [0],
          }],
        },
      };
      return this.result<T>(sessionId, output);
    }
    if (input.title.includes('测试执行')) {
      return this.result<T>(sessionId, skillResult(
        'test-report',
        '# Test Report\n\n独立门禁由研序执行。',
        ['所有非豁免门禁有结果', '失败有可复现证据'],
      ));
    }
    if (input.title.includes('交付评审')) {
      return this.result<T>(sessionId, skillResult(
        'delivery-review',
        '# Delivery Review\n\n需求、变更和门禁证据一致。',
        ['结论引用实际证据', '偏差和限制未被隐藏'],
      ));
    }
    throw new Error(`Unexpected fake execution: ${input.title}`);
  }

  abortSession(runtime: RuntimeHandle, sessionId: string): Promise<void> {
    void sessionId;
    this.blocked.get(runtime.id)?.(new Error('Injected session interruption.'));
    this.blocked.delete(runtime.id);
    return Promise.resolve();
  }

  async stopRuntime(runtime: RuntimeHandle): Promise<void> {
    await this.abortSession(runtime, '');
  }

  private result<T>(sessionId: string, output: unknown): StructuredExecutionResult<T> {
    return { sessionId, output: output as T };
  }

  private plan() {
    const steps = this.configuration.fullFlow
      ? [
        this.step('technical-design', this.configuration.developerId, '技术方案', 'TechnicalPlan', 0),
        this.step('implementation', this.configuration.developerId, '内容实施', '实现摘要', 1),
        this.step('test-design', this.configuration.testerId ?? '', '测试设计', 'TestPlan', 2),
        this.step('test-execution', this.configuration.testerId ?? '', '测试执行', '测试报告', 3),
        this.step('delivery-review', this.configuration.reviewerId ?? '', '交付评审', 'DeliveryReview', 4),
      ]
      : [this.step('implementation', this.configuration.developerId, '内容实施', '实现摘要', 0)];
    return {
      goal: '自动完成任务并形成证据',
      scope: ['关联目录'],
      nonScope: ['远程发布'],
      successCriteria: ['实现结果存在且门禁通过'],
      assumptions: [],
      risks: [],
      questions: [],
      steps,
      permissions: ['读取和写入隔离工作区', '执行已确认质量门禁'],
      qualityGates: this.configuration.fullFlow ? [{
        name: 'test',
        commandArgv: [process.execPath, '-e', 'process.exit(0)'],
        directoryId: this.configuration.directoryId,
        required: true,
        timeoutMs: 30_000,
        expectedExitCodes: [0],
      }] : [],
    };
  }

  private step(skillId: string, agentId: string, title: string, expectedOutput: string, position: number) {
    return {
      skillId,
      agentId,
      title,
      description: `${title}自动化步骤。`,
      inputs: position === 0 ? ['RequirementSpec'] : ['上游产物'],
      expectedOutput,
      directoryIds: [this.configuration.directoryId],
    };
  }
}

function skillResult(artifactType: string, content: string, checks: string[]): SkillResult {
  return {
    status: 'succeeded',
    summary: `${artifactType} completed`,
    artifacts: [{ type: artifactType, content }],
    issues: [],
    assumptions: [],
    requestedScopeChanges: [],
    reportedChecks: [],
    completionChecks: checks.map((check) => ({ check, status: 'passed', evidence: `${check} 已验证。` })),
  };
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for scheduler state.');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('scheduler end-to-end', () => {
  it('runs requirement, plan, implementation, testing, gates and review to delivery without supervision', async () => {
    const fixture = createFixture(true);
    try {
      fixture.scheduler.start();
      let task = fixture.store.submitTask(fixture.taskId, fixture.store.getTask(fixture.taskId).stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'WAITING_PLAN_APPROVAL',
      );
      expect(fixture.store.getTaskEvidence(task.id).preApprovalArtifacts).toEqual([
        expect.objectContaining({ artifactType: 'requirement-spec', status: 'generated' }),
      ]);
      expect(task.plan).toMatchObject({
        preApprovalSkillIds: ['requirement-specification'],
        taskVersion: 2,
      });

      fixture.store.commandTask(task.id, 'confirm', task.stateVersion);
      const snapshot = fixture.store.getRunSnapshot(task.id);
      expect(snapshot?.taskVersion).toMatchObject({
        id: task.plan?.taskVersionId,
        version: task.plan?.taskVersion,
        status: 'approved',
      });
      expect(snapshot?.permissionManifests).toHaveLength(5);
      const implementationStepId = snapshot?.plan.steps[1]?.id;
      expect(snapshot?.permissionManifests.find((item) => item.stepId === implementationStepId))
        .toMatchObject({
          permissionMode: 'managed',
          readOnly: false,
          directoryIds: [snapshot?.plan.branchRoutes[0]?.directoryId],
        });
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'DELIVERED',
      );

      expect(task.steps.every((step) => step.status === 'succeeded')).toBe(true);
      const deliveredEvidence = fixture.store.getTaskEvidence(task.id);
      expect(deliveredEvidence).toMatchObject({
        preApprovalArtifacts: [expect.objectContaining({ status: 'approved' })],
        designedQualityGates: [expect.objectContaining({ name: 'critical acceptance' })],
        gateAttempts: [
          expect.objectContaining({ status: 'passed' }),
          expect.objectContaining({ status: 'passed' }),
        ],
      });
      expect(deliveredEvidence.deliveryReport?.markdown).toContain('## 实际变更');
      const changedFeature = deliveredEvidence.changeManifests
        .flatMap((manifest) => manifest.files.map((file) => ({ manifest, file })))
        .find(({ file }) => file.path === 'feature.txt');
      expect(changedFeature).toBeDefined();
      const fileDiff = fixture.scheduler.taskFileDiff(
        task.id,
        changedFeature?.manifest.directoryId ?? '',
        changedFeature?.file.path ?? '',
      );
      expect(fileDiff.diff).toContain('+implementation attempt 1');
      expect(() => fixture.scheduler.taskFileDiff(
        task.id,
        changedFeature?.manifest.directoryId ?? '',
        'not-in-manifest.txt',
      )).toThrow('不在任务实际变更清单');
      task = fixture.store.commandTask(task.id, 'self_merge', task.stateVersion);
      expect(task.status).toBe('ARCHIVED');
      const archivedEvidence = fixture.store.getTaskEvidence(task.id);
      expect(archivedEvidence).toMatchObject({
        deliveryActions: [expect.objectContaining({ action: 'self_merge', status: 'succeeded' })],
      });
      expect(archivedEvidence.deliveryReport?.markdown).toContain('self_merge · succeeded');
    } finally {
      fixture.scheduler.stop();
      await waitFor(() => fixture.scheduler.health(), (health) => health.activeJobs === 0);
      fixture.database.close();
    }
  }, 12_000);

  it('merges a delivered task to its target branch, reruns gates and archives the task', async () => {
    const fixture = createFixture(true);
    try {
      fixture.scheduler.start();
      let task = fixture.store.submitTask(fixture.taskId, fixture.store.getTask(fixture.taskId).stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'WAITING_PLAN_APPROVAL',
      );
      fixture.store.commandTask(task.id, 'confirm', task.stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'DELIVERED',
      );
      const mergeResults = await fixture.scheduler.mergeTask(task.id);
      fixture.store.recordDeliveryMerge(task.id, mergeResults);
      task = fixture.store.commandTask(task.id, 'merge', task.stateVersion);
      expect(task.status).toBe('ARCHIVED');
      const mergedFile = spawnSync('git', [
        '-C',
        join(fixture.root, 'repository'),
        'show',
        `${mergeResults[0]?.targetBranch ?? 'main'}:feature.txt`,
      ], { encoding: 'utf8' });
      expect(mergedFile.status).toBe(0);
      expect(mergedFile.stdout).toContain('implementation attempt 1');
      expect(fixture.store.getTaskEvidence(task.id).deliveryActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'merge_to_target', status: 'succeeded' }),
      ]));
    } finally {
      fixture.scheduler.stop();
      await waitFor(() => fixture.scheduler.health(), (health) => health.activeJobs === 0);
      fixture.database.close();
    }
  }, 12_000);

  it('runs the complete flow from a new empty non-Git project directory', async () => {
    const fixture = createFixture(true, false, false, false, true);
    try {
      expect(fixture.store.getProject(fixture.store.getTask(fixture.taskId).projectId).directories[0])
        .toMatchObject({ gitInitialized: false });
      fixture.scheduler.start();
      let task = fixture.store.submitTask(fixture.taskId, fixture.store.getTask(fixture.taskId).stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'WAITING_PLAN_APPROVAL',
      );
      fixture.store.commandTask(task.id, 'confirm', task.stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'DELIVERED',
      );
      expect(task.steps.every((step) => step.status === 'succeeded')).toBe(true);
      expect(fixture.store.getProject(task.projectId).directories[0]).toMatchObject({ gitInitialized: true });
    } finally {
      fixture.scheduler.stop();
      await waitFor(() => fixture.scheduler.health(), (health) => health.activeJobs === 0);
      fixture.database.close();
    }
  }, 12_000);

  it('stops a blocked executor session immediately, preserves state, and resumes the step in a new session', async () => {
    const fixture = createFixture(false, true);
    try {
      fixture.scheduler.start();
      let task = fixture.store.submitTask(fixture.taskId, fixture.store.getTask(fixture.taskId).stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'WAITING_PLAN_APPROVAL',
      );
      expect(task.plan?.preApprovalSkillIds).toEqual([]);
      expect(fixture.store.getTaskEvidence(task.id).preApprovalArtifacts).toEqual([]);
      fixture.store.commandTask(task.id, 'confirm', task.stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'RUNNING' && current.steps.some((step) => step.status === 'running'),
      );

      task = fixture.store.commandTask(task.id, 'stop', task.stateVersion);
      await fixture.scheduler.abortTask(task.id);
      await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.steps.some((step) => step.summary?.includes('Injected session interruption')),
      );
      task = fixture.store.commandTask(task.id, 'resume', fixture.store.getTask(task.id).stateVersion);
      expect(['RETRYING', 'RUNNING']).toContain(task.status);

      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'DELIVERED',
      );
      expect(task.steps[0]).toMatchObject({ status: 'succeeded', attempt: 2 });
    } finally {
      fixture.scheduler.stop();
      await waitFor(() => fixture.scheduler.health(), (health) => health.activeJobs === 0);
      fixture.database.close();
    }
  });

  it('lets the active step reach a checkpoint before pausing and does not start the next step', async () => {
    const fixture = createFixture(true, false, false, true);
    try {
      fixture.scheduler.start();
      let task = fixture.store.submitTask(fixture.taskId, fixture.store.getTask(fixture.taskId).stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'WAITING_PLAN_APPROVAL',
      );
      fixture.store.commandTask(task.id, 'confirm', task.stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'RUNNING'
          && current.steps.find((step) => step.skillId === 'implementation')?.status === 'running',
      );

      task = fixture.store.commandTask(task.id, 'pause', task.stateVersion);
      expect(task.status).toBe('PAUSED');
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.steps.find((step) => step.skillId === 'implementation')?.status === 'succeeded',
      );
      expect(task.status).toBe('PAUSED');
      expect(task.steps.find((step) => step.skillId === 'test-design')?.status).toBe('pending');
      expect(fixture.store.getTaskEvidence(task.id).sessions.at(-1)?.status).toBe('succeeded');

      task = fixture.store.commandTask(task.id, 'resume', task.stateVersion);
      expect(['RUNNING', 'VALIDATING']).toContain(task.status);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'DELIVERED',
      );
      expect(task.steps.every((step) => step.status === 'succeeded')).toBe(true);
    } finally {
      fixture.scheduler.stop();
      await waitFor(() => fixture.scheduler.health(), (health) => health.activeJobs === 0);
      fixture.database.close();
    }
  }, 20_000);

  it('discards a failed runtime and retries the step in a newly started runtime', async () => {
    const fixture = createFixture(false, false, true);
    try {
      fixture.scheduler.start();
      let task = fixture.store.submitTask(fixture.taskId, fixture.store.getTask(fixture.taskId).stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'WAITING_PLAN_APPROVAL',
      );
      fixture.store.commandTask(task.id, 'confirm', task.stateVersion);
      task = await waitFor(
        () => fixture.store.getTask(fixture.taskId),
        (current) => current.status === 'DELIVERED',
        15_000,
      );
      expect(task.steps[0]).toMatchObject({ status: 'succeeded' });
      expect(fixture.adapter.runtimeStartCount).toBeGreaterThanOrEqual(3);
      expect(fixture.store.getTaskEvidence(task.id).sessions).toEqual([
        expect.objectContaining({ status: 'failed', error: 'Injected executor runtime crash.' }),
        expect.objectContaining({ status: 'succeeded' }),
      ]);
    } finally {
      fixture.scheduler.stop();
      await waitFor(() => fixture.scheduler.health(), (health) => health.activeJobs === 0);
      fixture.database.close();
    }
  }, 20_000);
});

function createFixture(
  fullFlow: boolean,
  blockFirstImplementation = false,
  failFirstImplementation = false,
  delayFirstImplementation = false,
  emptyRepository = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'yanxu-scheduler-e2e-'));
  temporaryDirectories.push(root);
  const repository = join(root, 'repository');
  const workbench = join(root, 'workbench');
  mkdirSync(repository);
  if (!emptyRepository) writeFileSync(join(repository, 'README.md'), '# Scheduler E2E\n');
  const database = openDatabase(join(workbench, 'system', 'app.db'));
  const store = new YanxuStore(database, workbench);
  store.updateSettings({ coordinatorModel: 'test/fake', maxParallelTasks: 2, retryLimit: 2 });
  const product = store.createAgent({
    name: '产品',
    roleId: 'product',
    executor: 'opencode',
    model: 'test/fake',
    permissionMode: 'standard',
  }, availableOpenCode);
  const developer = store.createAgent({
    name: '研发',
    roleId: 'development',
    executor: 'opencode',
    model: 'test/fake',
    permissionMode: 'managed',
  }, availableOpenCode);
  const tester = store.createAgent({
    name: '测试',
    roleId: 'testing',
    executor: 'opencode',
    model: 'test/fake',
    permissionMode: 'managed',
  }, availableOpenCode);
  const reviewer = store.createAgent({
    name: '评审',
    roleId: 'review',
    executor: 'opencode',
    model: 'test/fake',
    permissionMode: 'managed',
  }, availableOpenCode);
  const team = store.createTeam({
    name: 'E2E 团队',
    memberIds: fullFlow ? [product.id, developer.id, tester.id, reviewer.id] : [developer.id],
  });
  const project = store.createProject({ name: 'E2E 项目', directoryPath: repository });
  const directoryId = project.directories[0]?.id;
  if (!directoryId) throw new Error('directory missing');
  const task = store.createTask({
    projectId: project.id,
    teamId: team.id,
    title: fullFlow ? '完整研发流程' : '可恢复实施',
    description: '自动完成需求并保留可追溯证据。',
    expectedOutput: '通过验证的本地交付',
  });
  const adapter = new FakeOpenCodeAdapter({
    directoryId,
    developerId: developer.id,
    testerId: tester.id,
    reviewerId: reviewer.id,
    fullFlow,
    blockFirstImplementation,
    failFirstImplementation,
    delayFirstImplementation,
  });
  const registry = new ExecutorRegistry([availableOpenCode], () => Promise.resolve([availableOpenCode]));
  const scheduler = new Scheduler(store, registry, adapter, 10);
  return { root, database, store, scheduler, adapter, taskId: task.id };
}

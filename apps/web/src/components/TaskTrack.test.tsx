import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Task, TaskDiagnostics, TaskEvidence } from '@yanxu/contracts';
import { TaskTrack } from './TaskTrack.js';
import { DeliveryConflictPanel, TaskDiagnosticsPanel, TaskHistory } from '../pages/TaskDetailPage.js';

const task: Task = {
  id: 'task_test',
  projectId: 'project_test',
  projectName: '研序测试项目',
  teamId: 'team_test',
  teamName: '研发团队',
  title: '实现可观测任务',
  description: '测试任务长条。',
  expectedOutput: '可见的执行信息',
  constraints: '',
  forbiddenPaths: [],
  status: 'RUNNING',
  stateVersion: 4,
  progress: 50,
  activeStepId: 'step_implementation',
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:01:00.000Z',
  plan: null,
  snapshot: null,
  steps: [{
    id: 'step_design',
    taskId: 'task_test',
    position: 0,
    skillId: 'technical-design',
    agentId: 'agent_test',
    title: '技术方案',
    description: '形成方案。',
    inputs: [],
    expectedOutput: '方案',
    directoryIds: ['dir_test'],
    status: 'succeeded',
    attempt: 1,
    startedAt: '2026-07-27T00:00:00.000Z',
    completedAt: '2026-07-27T00:00:30.000Z',
    summary: '完成',
  }, {
    id: 'step_implementation',
    taskId: 'task_test',
    position: 1,
    skillId: 'implementation',
    agentId: 'agent_test',
    title: '内容实施',
    description: '编写代码。',
    inputs: ['方案'],
    expectedOutput: '实现',
    directoryIds: ['dir_test'],
    status: 'running',
    attempt: 1,
    startedAt: new Date(Date.now() - 70_000).toISOString(),
    completedAt: null,
    summary: null,
  }],
  activeExecution: {
    agentId: 'agent_test',
    agentName: '研发一号',
    executor: 'opencode',
    model: 'test/model',
    sessionId: 'session_test',
    startedAt: new Date(Date.now() - 70_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
  },
};

describe('task observability components', () => {
  it('renders the active step, agent, executor, model, elapsed time and heartbeat', () => {
    const markup = renderToStaticMarkup(<MemoryRouter><TaskTrack task={task} /></MemoryRouter>);
    expect(markup).toContain('当前：内容实施');
    expect(markup).toContain('研发一号');
    expect(markup).toContain('opencode');
    expect(markup).toContain('test/model');
    expect(markup).toContain('已运行 1 分钟');
    expect(markup).toContain('心跳');
  });

  it('renders semantic conflict impact without hiding the reason', () => {
    const markup = renderToStaticMarkup(<DeliveryConflictPanel conflicts={[{
      id: 'conflict_test',
      taskId: 'task_test',
      directoryId: 'dir_test',
      taskBranch: 'yanxu/task',
      targetBranch: 'main',
      classification: 'semantic',
      conflicts: [{ path: 'src/feature.ts', reason: '同一业务判断发生重叠修改', hunkCount: 2 }],
      mechanicallyResolvableFiles: [],
      status: 'pending',
      resolution: null,
      createdAt: '2026-07-27T00:00:00.000Z',
      resolvedAt: null,
    }]} />);
    expect(markup).toContain('yanxu/task');
    expect(markup).toContain('src/feature.ts');
    expect(markup).toContain('2 个重叠区');
    expect(markup).toContain('同一业务判断发生重叠修改');
  });

  it('renders the queue position for a queued task', () => {
    const queuedTask: Task = {
      ...task,
      status: 'QUEUED',
      queuePosition: 2,
      activeStepId: null,
      activeExecution: null,
      steps: task.steps.map((step) => ({ ...step, status: 'pending', startedAt: null, completedAt: null })),
    };
    const markup = renderToStaticMarkup(<MemoryRouter><TaskTrack task={queuedTask} /></MemoryRouter>);
    expect(markup).toContain('排队第 2 位');
    expect(markup).toContain('等待并发槽位');
  });

  it('aggregates permission, conflict, recovery and event evidence in history', () => {
    const evidence: TaskEvidence = {
      requirementVersions: [],
      preApprovalArtifacts: [],
      permissionManifests: [],
      permissionRequests: [{
        id: 'permission_test',
        taskId: 'task_test',
        sessionId: 'session_test',
        permission: 'bash',
        patterns: ['pnpm test'],
        metadata: {},
        status: 'resolved',
        decision: 'once',
        message: null,
        createdAt: '2026-07-27T00:00:00.000Z',
        resolvedAt: '2026-07-27T00:00:01.000Z',
      }],
      attachments: [],
      artifacts: [],
      artifactPreviews: [],
      sessions: [],
      contextPacks: [],
      changeManifests: [],
      designedQualityGates: [],
      qualitySummary: {
        status: 'not_configured',
        configured: 0,
        required: 0,
        passed: 0,
        failed: 0,
        waived: 0,
        latestAttemptAt: null,
        blockingFindings: [],
        advisoryFindings: [],
      },
      gateAttempts: [],
      deliveryConflicts: [{
        id: 'conflict_history',
        taskId: 'task_test',
        directoryId: 'dir_test',
        taskBranch: 'yanxu/task',
        targetBranch: 'main',
        classification: 'semantic',
        conflicts: [{ path: 'src/conflict.ts', reason: '业务逻辑重叠', hunkCount: 1 }],
        mechanicallyResolvableFiles: [],
        status: 'pending',
        resolution: null,
        createdAt: '2026-07-27T00:00:00.000Z',
        resolvedAt: null,
      }],
      recoveries: [{
        id: 'recovery_test',
        taskId: 'task_test',
        jobId: 'job_test',
        reason: 'daemon_restarted',
        previousOwner: 'old',
        recoveredBy: 'new',
        action: 'job_requeued',
        createdAt: '2026-07-27T00:00:02.000Z',
      }],
      deliveryActions: [],
      deliveryReport: null,
    };
    const markup = renderToStaticMarkup(<TaskHistory evidence={evidence} events={[{
      seq: 1,
      id: 'event_test',
      aggregateType: 'task',
      aggregateId: 'task_test',
      type: 'task.created',
      actorType: 'user',
      message: '保存任务草稿。',
      payload: {},
      occurredAt: '2026-07-27T00:00:00.000Z',
    }]} />);
    expect(markup).toContain('1 已处理，0 待处理');
    expect(markup).toContain('语义冲突');
    expect(markup).toContain('daemon_restarted');
    expect(markup).toContain('保存任务草稿');
  });

  it('renders classified failures and execution cost in task diagnostics', () => {
    const decision = {
      seq: 2,
      id: 'event_blocked',
      aggregateType: 'task',
      aggregateId: 'task_test',
      type: 'task.blocked',
      actorType: 'system' as const,
      message: '相同失败重复出现，已停止盲目重试。',
      payload: {},
      occurredAt: '2026-07-27T00:02:00.000Z',
    };
    const diagnostics: TaskDiagnostics = {
      taskId: 'task_test',
      generatedAt: '2026-07-27T00:02:00.000Z',
      status: 'BLOCKED',
      currentStep: { id: 'step_implementation', title: '内容实施', attempt: 2 },
      statusReason: { type: decision.type, message: decision.message, occurredAt: decision.occurredAt },
      duration: { totalMs: 120_000, modelMs: 70_000, gateMs: 5_000, waitingMs: 45_000 },
      sessions: { total: 2, running: 0, succeeded: 0, failed: 2, interrupted: 0 },
      jobs: { total: 1, ready: 0, leased: 0, succeeded: 0, failed: 1, cancelled: 0, retries: 1 },
      planning: { versions: 1, currentVersion: 1, replans: 0 },
      context: { packs: 2, estimatedTokens: 12_345, truncatedPacks: 1 },
      recoveries: 0,
      quality: {
        status: 'not_configured', configured: 0, required: 0, passed: 0, failed: 0, waived: 0,
        latestAttemptAt: null, blockingFindings: [], advisoryFindings: [],
      },
      failures: [{
        jobId: 'job_test', jobType: 'RUN_SKILL_STEP', category: 'transient', code: null,
        message: 'Runtime crash', fingerprint: 'abcdef1234567890', retryable: true, suggestedAction: 'retry',
        repeated: true, attempt: 2, maxAttempts: 3, context: null, occurredAt: decision.occurredAt,
      }],
      recentDecisions: [decision],
    };
    const markup = renderToStaticMarkup(<TaskDiagnosticsPanel diagnostics={diagnostics} />);
    expect(markup).toContain('相同失败重复出现');
    expect(markup).toContain('重复指纹，停止盲重试');
    expect(markup).toContain('12,345');
    expect(markup).toContain('Runtime crash');
  });

  it('shows a diagnostic request failure instead of an endless loading card', () => {
    const markup = renderToStaticMarkup(
      <TaskDiagnosticsPanel diagnostics={undefined} error={new Error('接口不存在。')} />,
    );
    expect(markup).toContain('运行诊断加载失败');
    expect(markup).toContain('接口不存在。');
  });
});

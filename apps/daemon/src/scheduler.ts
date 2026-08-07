import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  PlanQuestionOption,
  ReviewFinding,
  SkillArtifactOutput,
  SkillDefinition,
  TaskContextPack,
  ExecutorType,
  TaskFileDiff,
  TaskPlan,
} from '@yanxu/contracts';
import { commandPatternsForPlanPermissions, DomainError, GitWorkspaceManager } from '@yanxu/core';
import type { ClaimedJob, YanxuStore } from '@yanxu/core';
import type { ExecutorAdapter, RuntimeHandle } from '@yanxu/executors';
import type { ExecutorRegistry } from './executor-registry.js';
import { runQualityGates } from './quality-gates.js';

export function workspacePermissionPathPatterns(relativeRoot: string, absoluteRoot: string): string[] {
  // OpenCode normalizes absolute file arguments before permission matching and
  // currently reports them without the leading slash on macOS. Keep both forms
  // so the approved workspace path still matches after that normalization.
  const normalizedAbsoluteRoot = absoluteRoot.replace(/^\/+/, '');
  return [...new Set([
    relativeRoot,
    `${relativeRoot}/**`,
    absoluteRoot,
    `${absoluteRoot}/**`,
    normalizedAbsoluteRoot,
    `${normalizedAbsoluteRoot}/**`,
  ])];
}

export function contextPackReadPathPatterns(contextPack: TaskContextPack): string[] {
  const explicitPaths = [
    contextPack.manifestPath,
    ...contextPack.upstreamArtifacts.map((artifact) => artifact.artifactPath),
    ...contextPack.gateEvidence.map((gate) => gate.logPath),
  ].filter((path): path is string => Boolean(path));
  return [...new Set(explicitPaths.flatMap((path) => [path, path.replace(/^\/+/, '')]))];
}

interface ComposedPlanQuestionOption {
  label: string;
  description: string;
  value: string;
  recommended: boolean;
}

interface ComposedPlanOutput {
  goal: string;
  scope: string[];
  nonScope: string[];
  successCriteria: string[];
  assumptions: string[];
  risks: string[];
  questions: Array<{
    question: string;
    options: ComposedPlanQuestionOption[];
  }>;
  steps: Array<{
    skillId?: string;
    agentId: string | null;
    title: string;
    description: string;
    inputs: string[];
    expectedOutput: string;
    directoryIds: string[];
    requiredCapabilities?: string[];
    capabilityIds?: string[];
    verification?: string[];
    mode?: 'read_only' | 'write';
    requiresIndependentSession?: boolean;
  }>;
  permissions: string[];
  qualityGates: Array<{
    name: string;
    commandArgv: string[];
    directoryId: string;
    required: boolean;
    timeoutMs: number;
    expectedExitCodes: number[];
  }>;
}

interface PreApprovalDecision {
  skillIds: string[];
  rationale: string;
}

const preApprovalDecisionSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    skillIds: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: ['requirement-specification'] },
      description: '只有确实需要在用户确认计划前形成正式产物的 Skill。',
    },
    rationale: { type: 'string' },
  },
  required: ['skillIds', 'rationale'],
};

const composedPlanSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goal: { type: 'string', description: '清晰、可验收的任务目标' },
    scope: { type: 'array', items: { type: 'string' } },
    nonScope: { type: 'array', items: { type: 'string' } },
    successCriteria: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
                value: { type: 'string' },
                recommended: { type: 'boolean' },
              },
              required: ['label', 'description', 'value', 'recommended'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skillId: {
            type: 'string',
            enum: ['technical-design', 'implementation', 'test-design', 'test-execution', 'delivery-review'],
          },
          agentId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          title: { type: 'string' },
          description: { type: 'string' },
          inputs: { type: 'array', items: { type: 'string' } },
          expectedOutput: { type: 'string' },
          directoryIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
        required: ['skillId', 'agentId', 'title', 'description', 'inputs', 'expectedOutput', 'directoryIds'],
      },
    },
    permissions: { type: 'array', items: { type: 'string' } },
    qualityGates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          commandArgv: { type: 'array', minItems: 1, items: { type: 'string' } },
          directoryId: { type: 'string' },
          required: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 1_000, maximum: 3_600_000 },
          expectedExitCodes: { type: 'array', minItems: 1, items: { type: 'integer' } },
        },
        required: ['name', 'commandArgv', 'directoryId', 'required', 'timeoutMs', 'expectedExitCodes'],
      },
    },
  },
  required: ['goal', 'scope', 'nonScope', 'successCriteria', 'assumptions', 'risks', 'questions', 'steps', 'permissions', 'qualityGates'],
};

const workUnitComposedPlanSchema: Record<string, unknown> = {
  ...composedPlanSchema,
  properties: {
    ...(composedPlanSchema.properties as Record<string, unknown>),
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          title: { type: 'string' },
          description: { type: 'string' },
          inputs: { type: 'array', items: { type: 'string' } },
          expectedOutput: { type: 'string' },
          directoryIds: { type: 'array', minItems: 1, items: { type: 'string' } },
          requiredCapabilities: { type: 'array', items: { type: 'string' } },
          capabilityIds: { type: 'array', uniqueItems: true, items: { type: 'string' } },
          verification: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['read_only', 'write'] },
          requiresIndependentSession: { type: 'boolean' },
        },
        required: [
          'agentId', 'title', 'description', 'inputs', 'expectedOutput', 'directoryIds',
          'requiredCapabilities', 'capabilityIds', 'verification', 'mode', 'requiresIndependentSession',
        ],
      },
    },
  },
};

function normalizePlanQuestionOptions(options: ComposedPlanQuestionOption[]): PlanQuestionOption[] {
  const normalized = options
    .map((option) => ({
      label: option.label.trim(),
      description: option.description.trim(),
      value: option.value.trim(),
      recommended: option.recommended,
    }))
    .filter((option) => option.label && option.description && option.value)
    .slice(0, 3);
  if (normalized.length < 2) {
    throw new Error('每个歧义问题必须提供至少两个有效方案。');
  }
  const recommendedIndex = normalized.findIndex((option) => option.recommended);
  const firstIndex = recommendedIndex >= 0 ? recommendedIndex : 0;
  const ordered = [
    normalized[firstIndex]!,
    ...normalized.filter((_, index) => index !== firstIndex),
  ];
  return ordered.map((option, index) => ({
    id: `option_${randomUUID().replaceAll('-', '')}`,
    label: option.label,
    description: option.description,
    value: option.value,
    recommended: index === 0,
  }));
}

export interface SkillResult {
  status: 'succeeded' | 'changes_required' | 'blocked';
  summary: string;
  artifacts: SkillArtifactOutput[];
  issues: string[];
  findings?: ReviewFinding[];
  assumptions: string[];
  requestedScopeChanges: string[];
  reportedChecks: string[];
  completionChecks: Array<{
    check: string;
    status: 'passed' | 'failed';
    evidence: string;
  }>;
}

export interface WorkUnitResult {
  status: 'succeeded' | 'changes_required' | 'blocked';
  summary: string;
  artifacts?: SkillArtifactOutput[];
  issues: string[];
  findings?: ReviewFinding[];
  assumptions: string[];
  requestedScopeChanges: string[];
  reportedChecks: string[];
}

export const workUnitResultSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['succeeded', 'changes_required', 'blocked'] },
    summary: { type: 'string' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          path: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
        },
        required: ['type', 'content'],
      },
    },
    issues: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'suggestion'] },
          category: { type: 'string', enum: ['correctness', 'security', 'testing', 'maintainability', 'scope', 'documentation', 'other'] },
          title: { type: 'string' }, description: { type: 'string' }, evidence: { type: 'string' },
          location: { type: 'string' }, recommendation: { type: 'string' }, blocking: { type: 'boolean' },
        },
        required: ['severity', 'category', 'title', 'description', 'evidence', 'recommendation', 'blocking'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    requestedScopeChanges: { type: 'array', items: { type: 'string' } },
    reportedChecks: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'issues', 'assumptions', 'requestedScopeChanges', 'reportedChecks'],
};

export function skillResultSchema(skill: SkillDefinition): Record<string, unknown> {
  const allowedStatuses = skill.canBlockDelivery
    ? ['succeeded', 'changes_required', 'blocked']
    : ['succeeded', 'blocked'];
  const testGateMetadataSchema = {
    type: 'object',
    additionalProperties: true,
    properties: {
      qualityGates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            commandArgv: { type: 'array', minItems: 1, items: { type: 'string' } },
            directoryId: { type: 'string' },
            required: { type: 'boolean' },
            timeoutMs: { type: 'integer', minimum: 1_000, maximum: 3_600_000 },
            expectedExitCodes: { type: 'array', minItems: 1, items: { type: 'integer' } },
          },
          required: ['name', 'commandArgv', 'directoryId', 'required', 'timeoutMs', 'expectedExitCodes'],
        },
      },
    },
    required: ['qualityGates'],
  };
  return {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: allowedStatuses },
    summary: { type: 'string' },
    artifacts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: skill.artifactTypes },
          title: { type: 'string' },
          content: { type: 'string' },
          path: { type: 'string' },
          metadata: skill.id === 'test-design'
            ? testGateMetadataSchema
            : { type: 'object', additionalProperties: true },
        },
        required: skill.id === 'test-design' ? ['type', 'content', 'metadata'] : ['type', 'content'],
      },
    },
    issues: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'suggestion'] },
          category: { type: 'string', enum: ['correctness', 'security', 'testing', 'maintainability', 'scope', 'documentation', 'other'] },
          title: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          location: { type: 'string' },
          recommendation: { type: 'string' },
          blocking: { type: 'boolean' },
        },
        required: ['severity', 'category', 'title', 'description', 'evidence', 'recommendation', 'blocking'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    requestedScopeChanges: { type: 'array', items: { type: 'string' } },
    reportedChecks: { type: 'array', items: { type: 'string' } },
    completionChecks: {
      type: 'array',
      minItems: skill.completionChecks.length,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          check: { type: 'string', enum: skill.completionChecks },
          status: { type: 'string', enum: ['passed', 'failed'] },
          evidence: { type: 'string' },
        },
        required: ['check', 'status', 'evidence'],
      },
    },
  },
  required: [
    'status', 'summary', 'artifacts', 'issues', 'assumptions',
    'requestedScopeChanges', 'reportedChecks', 'completionChecks',
    ...(skill.id === 'delivery-review' ? ['findings'] : []),
  ],
  };
}

export function nonBlockingSkillOutcomeGuidance(skill: SkillDefinition): string {
  if (skill.canBlockDelivery) return '';
  return '此 Skill 不能返回 changes_required：只要自身产物已按要求完成就返回 succeeded；计划修改或需要用户重新确认只是后续编排状态，不代表本 Skill 要求下游整改。需要扩大任务范围时填写 requestedScopeChanges，运行环境或必要输入导致无法继续时才返回 blocked，并在 issues 中给出可操作原因。';
}

export function requirementRevisionGuidance(revisionFeedback?: string): string {
  if (!revisionFeedback) return '';
  const sensitiveChangeGuidance = /敏感文件(?:改动|修订)|sensitive_change|\.env(?:[.*]|$)/i.test(revisionFeedback)
    ? ' revisionFeedback 涉及敏感文件时，所有以 .env 开头的文件（包括 .env、.env.local、.env.development、.env.production、.env.example 等）都属于运行时禁止产出：必须从需求范围、目录影响和后续实现清单中彻底移除，禁止用另一个 .env 变体替代，也不能通过内容白名单、示例值或用户审批重新纳入；确需非敏感配置时只能改用普通源码配置文件（例如 src/config/app.ts）或代码默认值。最终 RequirementSpec 的计划产出路径中不得出现任何 .env 文件。'
    : '';
  return `这是一次规格修订。逐条吸收 revisionFeedback 并成功形成新版规格后返回 succeeded；是否进入用户重新确认由研序编排器处理，不要因此返回 changes_required。${sensitiveChangeGuidance}`;
}

export function validateSkillResult(skill: SkillDefinition, result: SkillResult): void {
  const artifactTypes = new Set(result.artifacts.map((artifact) => artifact.type));
  const missingArtifacts = skill.artifactTypes.filter((artifactType) => !artifactTypes.has(artifactType));
  if (missingArtifacts.length > 0) {
    throw new DomainError(
      'SKILL_ARTIFACT_CONTRACT_FAILED',
      `${skill.name} 缺少必需产物：${missingArtifacts.join('、')}`,
      422,
      { skillId: skill.id, missingArtifacts },
    );
  }
  const checks = new Map(result.completionChecks.map((check) => [check.check, check]));
  const missingChecks = skill.completionChecks.filter((check) => !checks.has(check));
  if (missingChecks.length > 0) {
    throw new DomainError(
      'SKILL_COMPLETION_CHECK_MISSING',
      `${skill.name} 未逐项验证完成条件：${missingChecks.join('、')}`,
      422,
      { skillId: skill.id, missingChecks },
    );
  }
  const failedChecks = skill.completionChecks.filter((check) => checks.get(check)?.status !== 'passed');
  if (result.status === 'succeeded' && failedChecks.length > 0) {
    throw new DomainError(
      'SKILL_COMPLETION_CHECK_FAILED',
      `${skill.name} 不能在完成条件失败时返回成功。`,
      422,
      { skillId: skill.id, failedChecks },
    );
  }
  const blockingFindings = (result.findings ?? []).filter((finding) =>
    finding.blocking || ['critical', 'major'].includes(finding.severity));
  const hasLegacyBlockingIssues = !(result.findings?.length) && result.issues.length > 0;
  if (skill.id === 'delivery-review' && result.status === 'succeeded'
    && (blockingFindings.length > 0 || hasLegacyBlockingIssues)) {
    throw new DomainError(
      'DELIVERY_REVIEW_ISSUES_REQUIRE_CHANGES',
      `${skill.name} 仍报告待处理问题时不能返回成功。`,
      422,
      { skillId: skill.id, findings: blockingFindings, legacyIssues: hasLegacyBlockingIssues ? result.issues : [] },
    );
  }
  if (!skill.canBlockDelivery && result.status === 'changes_required') {
    throw new DomainError(
      'SKILL_OUTCOME_NOT_ALLOWED',
      `${skill.name} 不能要求下游整改；需要扩大范围时应返回 requestedScopeChanges，运行环境无法继续时应返回 blocked。`,
      422,
      { skillId: skill.id, outcome: result.status },
    );
  }
  if (result.status === 'blocked' && result.issues.length === 0) {
    throw new DomainError(
      'SKILL_BLOCK_REASON_REQUIRED',
      `${skill.name} 返回 blocked 时必须说明可操作的阻塞原因。`,
      422,
      { skillId: skill.id },
    );
  }
};

export function normalizeSkillResultOutcome(skill: SkillDefinition, result: SkillResult): SkillResult {
  if (skill.id !== 'delivery-review') return result;
  const legacyFindings: ReviewFinding[] = result.issues.map((issue) => ({
    severity: 'major',
    category: 'other',
    title: issue.slice(0, 120),
    description: issue,
    evidence: '来自旧版 issues 字段，缺少结构化定位；按保守规则处理。',
    recommendation: '修复后重新执行评审，并提供可追溯证据。',
    blocking: true,
  }));
  const findings = [...(result.findings ?? []), ...legacyFindings].map((finding) => ({
    ...finding,
    blocking: finding.blocking || ['critical', 'major'].includes(finding.severity),
  }));
  const blockingCount = findings.filter((finding) => finding.blocking).length;
  if (result.status !== 'succeeded' || blockingCount === 0) return { ...result, findings };
  return {
    ...result,
    findings,
    status: 'changes_required',
    summary: `${result.summary} 研序检测到评审仍报告 ${blockingCount} 项阻塞问题，已自动改判为需要整改。`,
  };
}

export class Scheduler {
  private readonly instanceId = `daemon_${randomUUID().replaceAll('-', '')}`;
  private readonly adapterOverride: ExecutorAdapter | undefined;
  private readonly git: GitWorkspaceManager;
  private readonly runtimes = new Map<string, { runtime: RuntimeHandle; adapter: ExecutorAdapter }>();
  private readonly taskAbortControllers = new Map<string, Set<AbortController>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly activeJobs = new Set<string>();

  constructor(
    private readonly store: YanxuStore,
    private readonly executors: ExecutorRegistry,
    adapter?: ExecutorAdapter,
    private readonly pollIntervalMs = 750,
  ) {
    this.adapterOverride = adapter;
    this.git = new GitWorkspaceManager(store.workbenchHome);
  }

  start(): void {
    this.store.reconcileExpiredLeases(this.instanceId);
    this.store.reconcileOrphanedActiveTasks();
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    void this.tick();
  }

  health(): { running: boolean; activeJobs: number } {
    return { running: this.timer !== null, activeJobs: this.activeJobs.size };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controllers of this.taskAbortControllers.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.taskAbortControllers.clear();
    for (const binding of this.runtimes.values()) void binding.adapter.stopRuntime(binding.runtime);
    this.runtimes.clear();
  }

  async abortTask(taskId: string): Promise<void> {
    for (const controller of this.taskAbortControllers.get(taskId) ?? []) controller.abort();
    const binding = this.runtimes.get(taskId);
    if (binding) {
      await binding.adapter.stopRuntime(binding.runtime);
      this.runtimes.delete(taskId);
    }
  }

  private async adapterFor(executor: ExecutorType): Promise<ExecutorAdapter> {
    if (this.adapterOverride && executor === 'opencode') return this.adapterOverride;
    return this.executors.adapter(executor);
  }

  async mergeTask(taskId: string) {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const taskWorkspaces = this.store.getPreparedWorkspaces(taskId);
    this.store.recordDeliveryAction(taskId, 'merge_to_target', 'started', {
      targets: taskWorkspaces.map((workspace) => ({
        directoryId: workspace.directoryId,
        taskBranch: workspace.taskBranch,
        targetBranch: workspace.targetBranch,
      })),
    });
    let results: ReturnType<GitWorkspaceManager['mergeToTargets']>;
    try {
      results = this.git.mergeToTargets(task, project, taskWorkspaces);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'GIT_SEMANTIC_CONFLICT') {
        this.store.recordDeliveryConflict(taskId, error);
      }
      this.store.recordDeliveryAction(taskId, 'merge_to_target', 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    let validationWorkspaces: ReturnType<GitWorkspaceManager['prepareTargetValidationWorkspaces']> = [];
    try {
      validationWorkspaces = this.git.prepareTargetValidationWorkspaces(taskId, project, results);
      const gateResults = await runQualityGates(
        taskId,
        this.store.getEffectiveQualityGates(taskId),
        validationWorkspaces,
        this.store.workbenchHome,
        this.store.nextGateAttempt(taskId),
      );
      this.store.saveGateResults(taskId, gateResults);
      if (gateResults.some((result) => result.status === 'failed')) {
        throw new DomainError(
          'GIT_POST_MERGE_GATE_FAILED',
          '任务分支合并后质量门禁失败，目标分支将恢复到合并前状态。',
          409,
          { results: gateResults.map((result) => ({ gateId: result.id, status: result.status, logPath: result.logPath })) },
        );
      }
    } catch (error) {
      try {
        this.git.rollbackMergeResults(project, taskWorkspaces, results);
        this.store.recordDeliveryRollback(taskId, results, error, true);
      } catch (rollbackError) {
        this.store.recordDeliveryRollback(taskId, results, rollbackError, false);
        this.store.recordDeliveryAction(taskId, 'merge_to_target', 'failed', {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          rollback: 'failed',
        });
        throw rollbackError;
      }
      this.store.recordDeliveryAction(taskId, 'merge_to_target', 'failed', {
        error: error instanceof Error ? error.message : String(error),
        rollback: 'succeeded',
      });
      throw error;
    } finally {
      this.git.cleanupTargetValidationWorkspaces(validationWorkspaces);
    }
    this.store.recordDeliveryAction(taskId, 'merge_to_target', 'succeeded', {
      results: results.map((result) => ({
        directoryId: result.directoryId,
        targetBranch: result.targetBranch,
        mergedCommit: result.mergedCommit,
        mechanicallyResolvedFiles: result.mechanicallyResolvedFiles,
      })),
    });
    this.store.refreshDeliveryReport(taskId);
    return results;
  }

  taskFileDiff(taskId: string, directoryId: string, path: string): TaskFileDiff {
    const manifestFile = this.store.getTaskEvidence(taskId).changeManifests
      .filter((manifest) => manifest.directoryId === directoryId)
      .flatMap((manifest) => manifest.files)
      .find((file) => file.path === path);
    if (!manifestFile) {
      throw new DomainError('TASK_DIFF_NOT_IN_MANIFEST', '该文件不在任务实际变更清单中。', 404, {
        directoryId,
        path,
      });
    }
    if (manifestFile.sensitive) {
      throw new DomainError('TASK_DIFF_SENSITIVE', '敏感文件 Diff 不允许通过工作台读取。', 403, {
        directoryId,
        path,
      });
    }
    const workspace = this.store.getPreparedWorkspaces(taskId).find((item) => item.directoryId === directoryId);
    if (!workspace) {
      throw new DomainError('TASK_WORKSPACE_MISSING', '任务目录工作区不存在。', 404, { directoryId });
    }
    return {
      taskId,
      directoryId,
      path,
      ...this.git.diff(workspace, path),
    };
  }

  private tick(): void {
    this.store.reconcileTimedOutLeases();
    this.store.reconcileOrphanedActiveTasks();
    const capacity = this.store.getSettings(this.executors.list()).maxParallelTasks;
    if (this.activeJobs.size >= capacity) return;
    const job = this.store.claimReadyJob(this.instanceId);
    if (!job) return;
    this.activeJobs.add(job.id);
    void this.runJob(job);
  }

  private async runJob(job: ClaimedJob): Promise<void> {
    const heartbeat = setInterval(() => this.store.heartbeatJob(job.id, this.instanceId), 10_000);
    try {
      this.store.assertJobExecutionCurrent(job);
      await this.execute(job);
      this.store.succeedJob(job.id, this.instanceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const task = this.store.getTask(job.aggregateId);
      const jobWasSuperseded = ['STOPPED', 'CANCELLED', 'PAUSED', 'WAITING_REAPPROVAL', 'BLOCKED'].includes(task.status)
        || (task.status === 'REPLANNING' && job.type !== 'COMPOSE_PLAN');
      if (jobWasSuperseded) {
        this.store.discardClaimedJob(job, message.slice(0, 4_000));
      }
      else this.store.failJob(job, error);
    } finally {
      clearInterval(heartbeat);
      this.activeJobs.delete(job.id);
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    if (job.type === 'COMPOSE_PLAN') {
      const feedback = typeof job.payload.feedback === 'string' ? job.payload.feedback : undefined;
      return this.composePlan(
        job.aggregateId,
        feedback,
        job.payload.autoResume === true,
        job.payload.preservePreviousSteps === true,
      );
    }
    if (job.type === 'PREPARE_WORKSPACE') return this.prepareWorkspace(job.aggregateId);
    if (job.type === 'RUN_SKILL_STEP') return this.runSkillStep(job);
    if (job.type === 'RUN_QUALITY_GATE') return this.runGates(job.aggregateId);
    throw new Error(`Job type ${job.type} is not implemented yet.`);
  }

  private prepareWorkspace(taskId: string): void {
    const task = this.store.getTask(taskId);
    const snapshot = this.store.getRunSnapshot(taskId);
    if (!snapshot) throw new Error('Confirmed task run snapshot is missing.');
    const project = this.store.ensureTaskDirectoriesGit(taskId);
    let workspaces: ReturnType<GitWorkspaceManager['prepare']>;
    try {
      workspaces = this.git.prepare({ ...task, plan: snapshot.plan }, project);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'GIT_SOURCE_DRIFT') {
        this.store.requestAutomaticReplan(
          taskId,
          `${error.message} 请刷新来源 Commit 和本地工作区基线，保留原任务目标与成功标准，并等待用户重新确认。`,
          'source_workspace_drift',
          false,
        );
        return;
      }
      throw error;
    }
    this.store.savePreparedWorkspaces(taskId, workspaces);
  }

  private async runSkillStep(job: ClaimedJob): Promise<void> {
    const taskId = job.aggregateId;
    const step = this.store.startOrResumeStep(taskId);
    this.store.assertJobExecutionCurrent(job, 'before_result', step);
    if (!step.agentId) throw new Error(`No agent is assigned to execution unit ${step.title}.`);
    const snapshot = this.store.getRunSnapshot(taskId);
    if (!snapshot) throw new Error('Confirmed task run snapshot is missing.');
    const agent = snapshot.agents.find((item) => item.id === step.agentId);
    if (!agent) throw new Error(`Agent ${step.agentId} is missing from the confirmed task run snapshot.`);
    const skill = snapshot.skills.find((item) => item.id === step.skillId);
    if (step.kind !== 'work_unit' && !skill) {
      throw new Error(`Skill ${step.skillId} is missing from the confirmed task run snapshot.`);
    }
    const installation = await this.executors.ensureAvailable(agent.executor);
    if (!installation.capabilities.includes('structured-output') || !installation.capabilities.includes('sessions')) {
      throw new DomainError('EXECUTOR_CAPABILITY_MISSING', `${installation.name} 缺少统一执行所需的 Session 或结构化输出能力。`, 422, {
        executor: agent.executor,
        capabilities: installation.capabilities,
      });
    }
    this.store.recordExecutorRuntimeCheck(
      taskId,
      step.id,
      installation,
      snapshot.executors?.find((item) => item.executor === agent.executor),
    );
    const adapter = await this.adapterFor(agent.executor);
    const permissionManifest = snapshot.permissionManifests?.find((item) => item.stepId === step.id);
    if (permissionManifest && permissionManifest.agentId !== agent.id) {
      throw new Error(`Permission manifest for step ${step.id} does not match its confirmed agent.`);
    }
    const permissionDirectoryIds = permissionManifest?.directoryIds ?? step.directoryIds;
    const workspaces = this.store.getPreparedWorkspaces(taskId);
    const baseCommits = new Map(workspaces.map((workspace) => [workspace.directoryId, this.git.head(workspace)]));
    const contextPack = this.store.buildContextPack(taskId, step.id);
    const contextReadPatterns = contextPackReadPathPatterns(contextPack);
    const sessionRecordId = this.store.createAgentSession(taskId, step, agent);
    const readOnly = permissionManifest?.readOnly
      ?? (step.kind === 'work_unit' ? step.mode !== 'write' : step.skillId !== 'implementation');
    const commandPatterns = [...new Set([
      'pwd',
      'ls',
      'ls -la',
      ...commandPatternsForPlanPermissions(snapshot.plan),
      ...(permissionManifest?.allowedCommandPatterns
        ?? (step.kind === 'work_unit' && step.mode === 'write'
          || step.skillId === 'implementation' || step.skillId === 'test-execution'
          ? this.allowedStepCommands(permissionDirectoryIds, snapshot)
          : ['git status*', 'git diff*'])),
    ])];
    const executionSettings = this.store.getSettings(this.executors.list());
    const taskCapabilities = snapshot.capabilities ?? [];
    const stepCapabilities = taskCapabilities.filter((item) => item.stepId === step.id && item.agentId === agent.id);
    const allowedSkillPatterns = stepCapabilities.filter((item) => item.kind === 'skill').map((item) => item.name);
    const allowedMcpToolPatterns = stepCapabilities.filter((item) => item.kind === 'mcp').map((item) => `${item.name}_*`);
    const deniedMcpToolPatterns = taskCapabilities
      .filter((item) => item.kind === 'mcp' && !stepCapabilities.some((selected) => selected.id === item.id))
      .map((item) => `${item.name}_*`);
    const abortController = this.registerTaskAbortController(taskId);
    const sessionTimeout = setTimeout(() => abortController.abort(), executionSettings.sessionTimeoutMs);
    let binding = this.runtimes.get(taskId);
    try {
      if (binding && binding.runtime.executor !== agent.executor) {
        await binding.adapter.stopRuntime(binding.runtime);
        this.runtimes.delete(taskId);
        binding = undefined;
      }
      if (!binding) {
        const workspaceRoot = join(this.store.workbenchHome, 'runtime', 'tasks', taskId, 'workspace');
        const runtimeDirectory = join(this.store.workbenchHome, 'runtime', 'tasks', taskId, 'executor');
        this.store.prepareTaskCapabilityProjection(taskId, agent.executor, runtimeDirectory);
        const runtime = await adapter.startRuntime(workspaceRoot, runtimeDirectory);
        binding = { runtime, adapter };
        this.runtimes.set(taskId, binding);
      }
      const runtime = binding.runtime;
      const resumeSessionId = step.requiresIndependentSession
        ? null
        : this.store.getResumableExternalSession(taskId, agent.id);
      const result = step.kind === 'work_unit'
        ? await adapter.executeStructured<WorkUnitResult>({
          runtime,
          title: `${step.position + 1}. ${step.title}`,
          model: agent.model,
          schema: workUnitResultSchema,
          abortSignal: abortController.signal,
          permissionMode: permissionManifest?.permissionMode ?? agent.permissionMode,
          readOnly,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          policy: {
            allowedReadPatterns: [
              ...this.workspacePermissionPatterns(permissionDirectoryIds, snapshot, workspaces),
              ...contextReadPatterns,
            ],
            allowedExternalDirectoryPatterns: contextReadPatterns,
            allowedEditPatterns: this.workspacePermissionPatterns(permissionDirectoryIds, snapshot, workspaces),
            allowedBashPatterns: commandPatterns,
            allowedSkillPatterns,
            allowedMcpToolPatterns,
            deniedMcpToolPatterns,
            denyUnlistedSkills: true,
            taskGrants: this.store.listTaskPermissionGrants(taskId),
            forbiddenReadPatterns: this.forbiddenReadPatterns(permissionDirectoryIds, snapshot),
            networkPolicy: executionSettings.networkPolicy,
            dependencyInstallPolicy: executionSettings.dependencyInstallPolicy,
          },
          onSessionStarted: (externalSessionId) => {
            this.store.recordExternalSessionId(sessionRecordId, externalSessionId);
          },
          onPermission: async (request) => {
            const permission = this.store.createPermissionRequest(taskId, request.sessionId, request);
            while (true) {
              const current = this.store.getPermissionRequest(permission.id);
              if (current.status === 'resolved' && current.decision) return current.decision;
              if (this.store.getTask(taskId).status === 'STOPPED') {
                return this.store.respondPermission(permission.id, 'reject', '任务已停止。').decision ?? 'reject';
              }
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          },
          prompt: this.workUnitPrompt(this.store.getTask(taskId), step.id, snapshot, contextPack),
        })
        : await adapter.executeStructured<SkillResult>({
        runtime,
        title: `${step.position + 1}. ${step.title}`,
        model: agent.model,
        schema: skillResultSchema(skill!),
        abortSignal: abortController.signal,
        permissionMode: permissionManifest?.permissionMode ?? agent.permissionMode,
        readOnly,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        policy: {
          allowedReadPatterns: [
            ...this.workspacePermissionPatterns(permissionDirectoryIds, snapshot, workspaces),
            ...contextReadPatterns,
          ],
          allowedExternalDirectoryPatterns: contextReadPatterns,
          allowedEditPatterns: this.workspacePermissionPatterns(permissionDirectoryIds, snapshot, workspaces),
          allowedBashPatterns: commandPatterns,
          allowedSkillPatterns,
          allowedMcpToolPatterns,
          deniedMcpToolPatterns,
          denyUnlistedSkills: true,
          taskGrants: this.store.listTaskPermissionGrants(taskId),
          forbiddenReadPatterns: this.forbiddenReadPatterns(permissionDirectoryIds, snapshot),
          networkPolicy: executionSettings.networkPolicy,
          dependencyInstallPolicy: executionSettings.dependencyInstallPolicy,
        },
        onSessionStarted: (externalSessionId) => {
          this.store.recordExternalSessionId(sessionRecordId, externalSessionId);
        },
        onPermission: async (request) => {
          const permission = this.store.createPermissionRequest(taskId, request.sessionId, request);
          while (true) {
            const current = this.store.getPermissionRequest(permission.id);
            if (current.status === 'resolved' && current.decision) return current.decision;
            if (this.store.getTask(taskId).status === 'STOPPED') {
              return this.store.respondPermission(permission.id, 'reject', '任务已停止。').decision ?? 'reject';
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        },
        prompt: this.skillPrompt(this.store.getTask(taskId), step.id, snapshot, contextPack),
      });
      if (step.kind !== 'work_unit') {
        const legacyOutput = normalizeSkillResultOutcome(skill!, result.output as SkillResult);
        validateSkillResult(skill!, legacyOutput);
        result.output = legacyOutput;
      } else if (result.output.status === 'blocked' && result.output.issues.length === 0) {
        throw new DomainError('WORK_UNIT_BLOCK_REASON_REQUIRED', '执行单元返回 blocked 时必须说明可操作的阻塞原因。', 422);
      }
      this.store.assertJobExecutionCurrent(job, 'before_result', step);
      const taskAfterExecution = this.store.getTask(taskId);
      if (!['RUNNING', 'RETRYING', 'PAUSED'].includes(taskAfterExecution.status)) {
        this.store.recordSessionFailure(sessionRecordId, step.id, `执行在任务状态 ${taskAfterExecution.status} 下结束，结果未入库。`);
        return;
      }
      const inspections = workspaces.map((workspace) => {
        const directory = snapshot.directories.find((item) => item.id === workspace.directoryId);
        if (!directory) throw new Error(`Directory ${workspace.directoryId} is missing from the run snapshot.`);
        const selectedPrefix = this.directoryScopePrefix(directory);
        const forbiddenPaths = snapshot.task.forbiddenPaths.flatMap((path) => [
          path,
          selectedPrefix ? `${selectedPrefix}/${path.replace(/^\/+/, '')}` : path,
        ]);
        return this.git.inspectChanges(
          workspace,
          baseCommits.get(workspace.directoryId) ?? workspace.baselineCommit,
          step.directoryIds.includes(workspace.directoryId) ? [selectedPrefix === '.' ? '' : selectedPrefix] : [],
          forbiddenPaths,
        );
      });
      const violatingFiles = inspections.flatMap((inspection) => inspection.files
        .filter((file) => !file.inApprovedScope || file.sensitive)
        .map((file) => ({ directoryId: inspection.directoryId, path: file.path, sensitive: file.sensitive })));
      if (violatingFiles.length > 0) {
        this.store.recordSessionFailure(sessionRecordId, step.id, '工作区检测到越界或敏感文件改动，结果未入库。');
        this.store.handleScopeViolation(taskId, step.id, {
          reason: violatingFiles.some((file) => file.sensitive) ? 'sensitive_change' : 'out_of_scope_change',
          files: violatingFiles,
        });
        for (const workspace of workspaces) {
          this.git.discardUnapprovedAttempt(
            workspace,
            baseCommits.get(workspace.directoryId) ?? workspace.baselineCommit,
          );
        }
        await adapter.stopRuntime(runtime);
        this.runtimes.delete(taskId);
        return;
      }
      const readOnlyChanges = readOnly
        ? inspections.flatMap((inspection) => inspection.files.map((file) => ({
          directoryId: inspection.directoryId,
          path: file.path,
          sensitive: file.sensitive,
        })))
        : [];
      if (readOnlyChanges.length > 0) {
        this.store.recordSessionFailure(sessionRecordId, step.id, `只读${step.kind === 'work_unit' ? ' WorkUnit' : ' SkillStep'} 产生了工作区文件改动，结果未入库。`);
        this.store.handleScopeViolation(taskId, step.id, {
          reason: 'read_only_change',
          files: readOnlyChanges,
        });
        for (const workspace of workspaces) {
          this.git.discardUnapprovedAttempt(
            workspace,
            baseCommits.get(workspace.directoryId) ?? workspace.baselineCommit,
          );
        }
        await adapter.stopRuntime(runtime);
        this.runtimes.delete(taskId);
        return;
      }
      if (result.output.requestedScopeChanges.length > 0) {
        this.store.recordSessionFailure(sessionRecordId, step.id, '执行人员报告需要扩大已批准范围。');
        this.store.handleScopeViolation(taskId, step.id, {
          reason: 'reported_scope_expansion',
          requestedScopeChanges: result.output.requestedScopeChanges,
          files: inspections.flatMap((inspection) => inspection.files.map((file) => ({
            directoryId: inspection.directoryId,
            path: file.path,
            sensitive: file.sensitive,
          }))),
        });
        for (const workspace of workspaces) {
          this.git.discardUnapprovedAttempt(
            workspace,
            baseCommits.get(workspace.directoryId) ?? workspace.baselineCommit,
          );
        }
        await adapter.stopRuntime(runtime);
        this.runtimes.delete(taskId);
        return;
      }
      if (result.output.status !== 'succeeded') {
        const status = result.output.status;
        if (status === 'changes_required') {
          for (const workspace of workspaces) {
            this.git.discardUnapprovedAttempt(
              workspace,
              baseCommits.get(workspace.directoryId) ?? workspace.baselineCommit,
            );
          }
        }
        const outcomeTask = this.store.handleNonPassingStep(
          taskId,
          step.id,
          sessionRecordId,
          result.sessionId,
          { ...result.output, artifacts: result.output.artifacts ?? [], status },
          this.store.getSettings(this.executors.list()).retryLimit,
        );
        if (['BLOCKED', 'STOPPED', 'CANCELLED', 'ARCHIVED'].includes(outcomeTask.status)) {
          await adapter.stopRuntime(runtime);
          this.runtimes.delete(taskId);
        }
        return;
      }
      if ((step.kind === 'work_unit' && step.mode === 'write')
        || (step.kind !== 'work_unit' && step.skillId === 'implementation')) {
        const changedFiles = inspections.flatMap((inspection) =>
          inspection.files.map((file) => `${inspection.directoryId}:${file.path}`));
        if (changedFiles.length === 0) {
          throw new DomainError(
            'WORK_UNIT_CHANGE_REQUIRED',
            '可写执行单元返回成功，但隔离工作区没有任何可由 Git 重建的文件变更。报告内容不能代替实际文件落盘。',
            422,
            {
              taskId,
              stepId: step.id,
              attempt: step.attempt,
              workspaceIds: workspaces.map((workspace) => workspace.directoryId),
            },
          );
        }
      }
      const checkpoints = workspaces.map((workspace) => {
        const inspection = inspections.find((item) => item.directoryId === workspace.directoryId);
        if (!inspection) throw new Error(`Change inspection for ${workspace.directoryId} is missing.`);
        const commit = this.git.checkpoint(workspace, `yanxu(${step.skillId}): ${result.output.summary.slice(0, 72)}`);
        return {
          directoryId: workspace.directoryId,
          baseCommit: inspection.baseCommit,
          commit,
          inspection,
        };
      });
      this.store.completeStep(taskId, step.id, sessionRecordId, result.sessionId, {
        ...result.output,
        artifacts: result.output.artifacts ?? [],
      }, checkpoints);
      const current = this.store.getTask(taskId);
      if (['DELIVERED', 'BLOCKED', 'STOPPED', 'CANCELLED', 'ARCHIVED'].includes(current.status)) {
        await adapter.stopRuntime(runtime);
        this.runtimes.delete(taskId);
      }
    } catch (error) {
      this.store.recordSessionFailure(sessionRecordId, step.id, error instanceof Error ? error.message : String(error));
      const failedBinding = this.runtimes.get(taskId);
      if (failedBinding) {
        await failedBinding.adapter.stopRuntime(failedBinding.runtime);
        this.runtimes.delete(taskId);
      }
      throw error;
    } finally {
      clearTimeout(sessionTimeout);
      this.unregisterTaskAbortController(taskId, abortController);
    }
  }

  private async runGates(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const attempt = this.store.nextGateAttempt(taskId);
    let validationWorkspaces: ReturnType<GitWorkspaceManager['prepareTaskValidationWorkspaces']> = [];
    let results: Awaited<ReturnType<typeof runQualityGates>>;
    const abortController = this.registerTaskAbortController(taskId);
    try {
      validationWorkspaces = this.git.prepareTaskValidationWorkspaces(
        taskId,
        project,
        this.store.getPreparedWorkspaces(taskId),
      );
      results = await runQualityGates(
        taskId,
        this.store.getEffectiveQualityGates(taskId),
        validationWorkspaces,
        this.store.workbenchHome,
        attempt,
        abortController.signal,
      );
    } finally {
      this.unregisterTaskAbortController(taskId, abortController);
      this.git.cleanupTargetValidationWorkspaces(validationWorkspaces);
    }
    this.store.saveGateResults(taskId, results);
    if (this.store.getTask(taskId).status !== 'VALIDATING') return;
    if (results.every((result) => result.status === 'passed')) this.store.continueAfterGates(taskId);
    else this.store.retryAfterGateFailure(taskId, this.store.getSettings(this.executors.list()).retryLimit);
  }

  private skillPrompt(
    task: ReturnType<YanxuStore['getTask']>,
    stepId: string,
    snapshot: NonNullable<ReturnType<YanxuStore['getRunSnapshot']>>,
    contextPack: TaskContextPack,
  ): string {
    const step = task.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`Step ${stepId} is missing.`);
    const skill = snapshot.skills.find((item) => item.id === step.skillId);
    const agent = step.agentId ? snapshot.agents.find((item) => item.id === step.agentId) : null;
    const role = snapshot.roles.find((item) => item.id === agent?.roleId);
    const workspaces = this.store.getPreparedWorkspaces(task.id).filter((workspace) => step.directoryIds.includes(workspace.directoryId));
    const executionContextPack = {
      ...contextPack,
      directories: contextPack.directories.map((directory) => ({
        id: directory.id,
        displayName: directory.displayName,
        gitInitialized: directory.gitInitialized,
        currentBranch: directory.currentBranch,
        isDirty: directory.isDirty,
        contentTypes: directory.contentTypes,
        stack: directory.stack,
        commands: directory.commands,
        localBranches: directory.localBranches,
        scannedAt: directory.scannedAt,
      })),
    };
    const testDesignRule = step.skillId === 'test-design'
      ? '\n测试设计的 test-plan artifact.metadata.qualityGates 必须列出专项可执行门禁；每条 commandArgv 只能在冻结计划已有同目录命令后追加更窄的测试范围或参数，不能更换可执行程序或子命令。没有安全专项门禁时返回空数组并在正文说明原因。'
      : '';
    const workspaceRule = step.skillId === 'implementation'
      ? '当前步骤必须使用当前 CLI 的原生文件编辑工具把批准的代码或文档真实写入授权隔离工作区。创建新文件时直接使用授权工作区内的绝对文件路径；不要用报告代替真实修改。Artifact 只是实现报告；返回 succeeded 前必须通过 Git status/diff 确认至少一个批准范围内的文件发生变更，否则研序会拒绝本次结果。'
      : '当前步骤工作区只读；不要在代码仓库或临时目录创建产物，完整内容必须通过 artifacts 返回，研序会将其版本化写入 ProjectSpace。';
    const reviewRule = step.skillId === 'delivery-review'
      ? ' 评审必须先核对 ChangeManifest 和 Git 实际文件：实施步骤 files=0、checkpoint 等于 baseline，或计划要求的目标文件不存在时，必须判定 changes_required。上下文中的 Artifact 摘要被截断时，应从授权只读工作区读取 ChangeManifest 对应文件，不得把截断误判为文件缺失。每个问题必须写入 findings，包含 severity、category、证据、定位、建议和 blocking；critical/major 一律阻塞交付并返回 changes_required，minor/suggestion 可以随 succeeded 交付但必须保留在报告。issues 仅用于兼容旧输出；一旦填写会按阻塞问题保守处理。'
      : '';
    return `你正在研序中以“${role?.name ?? '执行人员'}”身份执行 Skill“${skill?.name ?? step.skillId}”。\n\n责任边界：\n${role?.responsibilities.map((item) => `- ${item}`).join('\n') ?? '- 按批准计划完成当前步骤'}\n\n当前 Skill 目标：${step.description || skill?.description}\n本步骤输入：${step.inputs.join('；') || '当前任务和上游结构化产物'}\n预期结构化产出：${step.expectedOutput}\n必需 Artifact 类型：${skill?.artifactTypes.join('、') ?? '按 Schema 返回'}\n必须逐项验证的完成条件：\n${skill?.completionChecks.map((item) => `- ${item}`).join('\n') ?? '- 按批准计划完成'}\n\n本步骤最小上下文包（包含冻结计划、上游 ArtifactVersion、相关项目知识和失败证据；其中项目目录只提供元数据，不是可直接访问的物理路径）：\n${JSON.stringify(executionContextPack, null, 2)}\n\n本步骤授权的隔离工作区（只能在这些路径内工作）：\n${JSON.stringify(workspaces, null, 2)}\n\n规则：${workspaceRule}${reviewRule} 严格遵守已批准范围；不要访问上下文提到的原始仓库位置，只能使用上方授权的隔离工作区；不要 push、创建远程 PR 或部署；不要读取密钥与环境变量文件；需要扩大范围时不要擅自实施，在 requestedScopeChanges 中说明。artifacts 必须返回 Schema 指定的必需类型，content 应是可供下一步骤直接消费的完整结构化 Markdown，而不是只返回工作区路径。completionChecks 必须逐项给出 passed/failed 和可追溯证据。测试执行或交付评审发现必须整改的问题时返回 changes_required；任何 Skill 因工具权限、运行环境或缺少必要输入而无法安全继续时返回 blocked，并在 issues 中写明可操作原因；其他情况不得用非成功状态代替范围变更。reportedChecks 只是你的报告，研序会独立运行质量门禁。${testDesignRule}`;
  }

  private workUnitPrompt(
    task: ReturnType<YanxuStore['getTask']>,
    stepId: string,
    snapshot: NonNullable<ReturnType<YanxuStore['getRunSnapshot']>>,
    contextPack: TaskContextPack,
  ): string {
    const step = task.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`Step ${stepId} is missing.`);
    const agent = step.agentId ? snapshot.agents.find((item) => item.id === step.agentId) : null;
    const role = snapshot.roles.find((item) => item.id === agent?.roleId);
    const workspaces = this.store.getPreparedWorkspaces(task.id)
      .filter((workspace) => step.directoryIds.includes(workspace.directoryId));
    const modeRule = step.mode === 'write'
      ? '这是可写执行单元。使用当前 CLI 的原生 Write/Edit 文件工具在授权隔离工作区内完成真实修改；Write 会递归创建缺失的父目录，不要先调用 mkdir，也不要用 echo、cat 或重定向代替文件工具。用 Git diff/status 核对结果，不要用报告代替文件落盘。'
      : '这是只读执行单元。只检查、分析和给出结论，不得修改隔离工作区文件。';
    const independentRule = step.requiresIndependentSession
      ? '这是独立复核会话，不要默认信任前序人员的自述；以工作区、Git 变更和实际门禁证据为准。'
      : '这是同一任务的连续执行；优先利用会话中已经建立的项目理解，并用当前上下文包校准可能变化的事实。';
    const loadedCapabilities = (snapshot.capabilities ?? [])
      .filter((item) => item.stepId === step.id && item.agentId === agent?.id)
      .map((item) => ({ id: item.capabilityId, name: item.name, kind: item.kind, version: item.version }));
    return `你正在研序中以“${role?.name ?? '执行人员'}”身份，通过 ${agent?.executor ?? '本地 CLI'} 完成一个 WorkUnit。研序只负责边界、状态、证据和重试；请使用当前 CLI 自身的项目理解、工具和工作方式完成目标，不要把工作机械套入固定 Skill 模板。

角色责任：
${role?.responsibilities.map((item) => `- ${item}`).join('\n') ?? '- 对当前执行单元的结果负责'}

角色基础指令：
${role?.instructions || '遵守已批准计划和当前责任边界。'}

执行单元：${step.title}
目标：${step.description}
输入：${step.inputs.join('；') || '已确认计划与当前任务上下文'}
预期结果：${step.expectedOutput}
所需能力：${step.requiredCapabilities?.join('、') || '通用项目执行能力'}
本单元已装载能力：${loadedCapabilities.length ? JSON.stringify(loadedCapabilities) : '无'}
验证关注点：
${step.verification?.map((item) => `- ${item}`).join('\n') || '- 对照任务成功标准验证'}

最小上下文包（包含冻结计划、项目知识、前序结果、真实质量门禁与失败日志）：
${JSON.stringify(contextPack, null, 2)}

授权隔离工作区：
${JSON.stringify(workspaces, null, 2)}

规则：
- ${modeRule}
- ${independentRule}
- 只能访问授权工作区和上下文包显式列出的只读证据；不得访问原始仓库、密钥或环境变量文件。
- 不要 push、创建远程 PR 或部署。需要扩大目录、文件或命令范围时，停止实施并填写 requestedScopeChanges。
- artifacts 是可选的补充说明，不要求固定类型，也不能代替真实文件和实际检查。
- reportedChecks 只记录你实际做过的检查；研序以真实命令退出码和 Git 证据作为最终质量事实。
- 完成目标返回 succeeded；发现必须由前序写入单元整改的问题返回 changes_required 并给出具体证据；因权限、环境或必要输入缺失无法继续时返回 blocked，并在 issues 中说明可操作原因。`;
  }

  private async composePlan(
    taskId: string,
    revisionFeedback?: string,
    autoResume = false,
    preservePreviousSteps = false,
  ): Promise<void> {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const settings = this.store.getSettings(this.executors.list());
    if (!settings.coordinatorModel) throw new Error('Coordinator model is not configured.');
    await this.executors.ensureAvailable(settings.coordinatorExecutor);
    const adapter = await this.adapterFor(settings.coordinatorExecutor);

    const runtimeDirectory = join(this.store.workbenchHome, 'runtime', 'coordinator', task.id);
    const abortController = this.registerTaskAbortController(taskId);
    const sessionTimeout = setTimeout(() => abortController.abort(), settings.sessionTimeoutMs);
    let runtime: RuntimeHandle | null = null;
    try {
      runtime = await adapter.startRuntime(project.projectSpacePath, runtimeDirectory);
      this.runtimes.set(taskId, { runtime, adapter });
      if (abortController.signal.aborted) {
        const error = new Error(`${settings.coordinatorExecutor} coordinator session was aborted.`);
        error.name = 'AbortError';
        throw error;
      }
      const requirementSkill = this.store.getBuiltins().skills.find((skill) => skill.id === 'requirement-specification');
      if (!requirementSkill) throw new Error('Built-in requirement specification skill is missing.');
      const team = this.store.getTeam(task.teamId);
      const teamCoordinatorAgents = this.store.listAgents().filter((agent) =>
        team.memberIds.includes(agent.id) && agent.executor === settings.coordinatorExecutor);
      const productAgent = task.flowVersion === 2
        ? teamCoordinatorAgents.find((agent) => agent.roleId === 'product') ?? teamCoordinatorAgents[0]
        : teamCoordinatorAgents.find((agent) => {
          const role = this.store.getBuiltins().roles.find((item) => item.id === agent.roleId);
          return role?.skillIds.includes(requirementSkill.id);
        });
      const decision = await adapter.executeStructured<PreApprovalDecision>({
        runtime,
        title: `确认前技能选择 · ${task.title}`,
        model: settings.coordinatorModel,
        schema: preApprovalDecisionSchema,
        abortSignal: abortController.signal,
        permissionMode: 'managed',
        toolMode: 'disabled',
        readOnly: true,
        policy: {
          allowedReadPatterns: [],
          allowedEditPatterns: [],
          allowedBashPatterns: [],
          taskGrants: [],
          forbiddenReadPatterns: ['*'],
          networkPolicy: 'deny',
          dependencyInstallPolicy: 'deny',
        },
        prompt: this.preApprovalDecisionPrompt(task, project, Boolean(productAgent), revisionFeedback),
      });
      const existingRequirementArtifact = this.store.getTaskEvidence(task.id).preApprovalArtifacts
        .some((artifact) => artifact.artifactType === 'requirement-spec' && artifact.status !== 'superseded');
      const preApprovalSkillIds = [...new Set([
        ...decision.output.skillIds,
        ...(task.plan?.preApprovalSkillIds ?? []),
        ...(existingRequirementArtifact ? [requirementSkill.id] : []),
      ])]
        .filter((skillId) => skillId === requirementSkill.id);
      const missingPreApprovalSkillIds = preApprovalSkillIds.filter((skillId) =>
        skillId === requirementSkill.id && !productAgent);
      let requirementArtifact: SkillArtifactOutput | null = null;
      let requirementModel: string | null = null;
      let requirementSessionId: string | null = null;
      if (preApprovalSkillIds.includes(requirementSkill.id) && productAgent) {
        requirementModel = productAgent.model;
        const requirementResult = await adapter.executeStructured<SkillResult>({
          runtime,
          title: `需求规格 · ${task.title}`,
          model: requirementModel,
          schema: skillResultSchema(requirementSkill),
          abortSignal: abortController.signal,
          permissionMode: 'managed',
          toolMode: 'disabled',
          readOnly: true,
          policy: {
            allowedReadPatterns: [],
            allowedEditPatterns: [],
            allowedBashPatterns: [],
            taskGrants: [],
            forbiddenReadPatterns: ['*'],
            networkPolicy: 'deny',
            dependencyInstallPolicy: 'deny',
          },
          prompt: this.requirementPrompt(task, project, requirementSkill, revisionFeedback),
        });
        validateSkillResult(requirementSkill, requirementResult.output);
        requirementArtifact = requirementResult.output.artifacts.find((artifact) =>
          artifact.type === 'requirement-spec') ?? null;
        if (!requirementArtifact) throw new Error('Requirement specification did not return a requirement-spec artifact.');
        requirementSessionId = requirementResult.sessionId;
      }

      const result = await adapter.executeStructured<ComposedPlanOutput>({
        runtime,
        title: `研序计划 · ${task.title}`,
        model: settings.coordinatorModel,
        schema: task.flowVersion === 2 ? workUnitComposedPlanSchema : composedPlanSchema,
        abortSignal: abortController.signal,
        permissionMode: 'managed',
        toolMode: 'disabled',
        readOnly: true,
        policy: {
          allowedReadPatterns: [],
          allowedEditPatterns: [],
          allowedBashPatterns: [],
          taskGrants: [],
          forbiddenReadPatterns: ['*'],
          networkPolicy: 'deny',
          dependencyInstallPolicy: 'deny',
        },
        prompt: this.planPrompt(
          task,
          project,
          requirementArtifact?.content ?? null,
          preApprovalSkillIds,
          revisionFeedback,
          preservePreviousSteps,
        ),
      });
      const draft: Partial<TaskPlan> = {
        ...result.output,
        preApprovalSkillIds,
        answersReviewedAt: task.plan?.questions.length
          && task.plan.questions.every((question) => question.answer?.trim())
          ? new Date().toISOString()
          : null,
        questions: [
          ...result.output.questions.map((item) => ({
            id: `q_${randomUUID().replaceAll('-', '')}`,
            question: item.question,
            options: normalizePlanQuestionOptions(item.options),
            answer: null,
          })),
          ...missingPreApprovalSkillIds.map((skillId) => ({
            id: `q_${randomUUID().replaceAll('-', '')}`,
            question: `协调器判定确认前需要 ${skillId}，但当前团队没有具备该 Skill 的可用人员。请先编辑团队，再请求重新生成计划。`,
            options: normalizePlanQuestionOptions([
              {
                label: '先完善团队',
                description: '为当前团队补充具备该 Skill 的可用人员，再重新生成完整计划。',
                value: `先为当前团队补充具备 ${skillId} 的可用人员，然后重新生成计划。`,
                recommended: true,
              },
              {
                label: '缩减任务范围',
                description: '移除依赖该 Skill 的工作，并同步收窄目标、范围和成功标准。',
                value: `调整计划，移除对 ${skillId} 的依赖，并同步缩减任务范围和成功标准。`,
                recommended: false,
              },
            ]),
            answer: null,
          })),
        ],
        steps: result.output.steps.map((step, position) => ({
          ...step,
          id: `planstep_${randomUUID().replaceAll('-', '')}`,
          position,
          skillId: task.flowVersion === 2 ? 'work-unit' : (step.skillId ?? 'implementation'),
          kind: task.flowVersion === 2 ? 'work_unit' as const : 'legacy_skill' as const,
          requiredCapabilities: step.requiredCapabilities ?? [],
          capabilityIds: step.capabilityIds ?? [],
          verification: step.verification ?? [],
          mode: step.mode ?? (step.skillId === 'implementation' ? 'write' as const : 'read_only' as const),
          requiresIndependentSession: step.requiresIndependentSession ?? false,
        })),
        qualityGates: result.output.qualityGates.map((gate) => {
          const previous = task.plan?.qualityGates.find((item) =>
            item.directoryId === gate.directoryId
            && item.name === gate.name
            && (item.commandArgv ?? item.command.split(/\s+/)).join('\u0000') === gate.commandArgv.join('\u0000'));
          return {
            id: previous?.id ?? `gate_${randomUUID().replaceAll('-', '')}`,
            name: gate.name,
            command: gate.commandArgv.join(' '),
            commandArgv: gate.commandArgv,
            directoryId: gate.directoryId,
            source: previous?.source ?? 'task_specific',
            timeoutMs: gate.timeoutMs,
            expectedExitCodes: gate.expectedExitCodes,
            required: gate.required,
            status: 'pending' as const,
          };
        }),
      };
      this.store.saveComposedPlan(task.id, draft, requirementArtifact && requirementModel
        ? [{
          artifactType: requirementArtifact.type,
          title: requirementArtifact.title?.trim() || `${task.title} · 需求规格`,
          content: requirementArtifact.content,
          sourceExecutor: settings.coordinatorExecutor,
          sourceModel: requirementModel,
          sourceSessionId: requirementSessionId,
        }]
        : [], { preservePreviousSteps });
      if (autoResume) this.store.resumeAutomaticReplanIfSafe(task.id);
    } finally {
      clearTimeout(sessionTimeout);
      this.unregisterTaskAbortController(taskId, abortController);
      if (runtime) {
        await adapter.stopRuntime(runtime);
        if (this.runtimes.get(taskId)?.runtime === runtime) this.runtimes.delete(taskId);
      }
    }
  }

  private allowedStepCommands(
    directoryIds: string[],
    snapshot: NonNullable<ReturnType<YanxuStore['getRunSnapshot']>>,
  ): string[] {
    const allowed = new Set<string>([
      'pwd',
      'ls',
      'ls -la',
      'git status*',
      'git diff*',
    ]);
    for (const gate of snapshot.plan.qualityGates) {
      if (!directoryIds.includes(gate.directoryId) || gate.status === 'waived') continue;
      const directory = snapshot.directories.find((item) => item.id === gate.directoryId);
      if (!directory) continue;
      const prefix = this.directoryScopePrefix(directory);
      const commandRoot = prefix ? `${gate.directoryId}/${prefix}` : gate.directoryId;
      allowed.add(gate.command);
      allowed.add(`${gate.command} *`);
      allowed.add(`cd ${commandRoot} && ${gate.command}`);
      allowed.add(`cd ${commandRoot} && ${gate.command} *`);
    }
    return [...allowed];
  }

  private forbiddenReadPatterns(
    directoryIds: string[],
    snapshot: NonNullable<ReturnType<YanxuStore['getRunSnapshot']>>,
  ): string[] {
    return directoryIds.flatMap((directoryId) => {
      const directory = snapshot.directories.find((item) => item.id === directoryId);
      if (!directory) return [];
      const prefix = this.directoryScopePrefix(directory);
      const root = prefix ? `${directoryId}/${prefix}` : directoryId;
      return snapshot.task.forbiddenPaths.flatMap((path) => {
        const normalized = path.replaceAll('\\', '/').replace(/^\.?\/+/, '');
        return [`${root}/${normalized}`, `${root}/${normalized}/**`];
      });
    });
  }

  private workspacePermissionPatterns(
    directoryIds: string[],
    snapshot: NonNullable<ReturnType<YanxuStore['getRunSnapshot']>>,
    workspaces: ReturnType<YanxuStore['getPreparedWorkspaces']>,
  ): string[] {
    return directoryIds.flatMap((directoryId) => {
      const directory = snapshot.directories.find((item) => item.id === directoryId);
      const workspace = workspaces.find((item) => item.directoryId === directoryId);
      if (!directory || !workspace) return [];
      const prefix = this.directoryScopePrefix(directory);
      const relativeRoot = prefix ? `${directoryId}/${prefix}` : directoryId;
      const absoluteRoot = prefix ? join(workspace.workspacePath, prefix) : workspace.workspacePath;
      return workspacePermissionPathPatterns(relativeRoot, absoluteRoot);
    });
  }

  private directoryScopePrefix(directory: NonNullable<ReturnType<YanxuStore['getRunSnapshot']>>['directories'][number]): string {
    const prefix = relative(directory.gitRootPath ?? directory.realPath, directory.realPath)
      .replaceAll('\\', '/')
      .replace(/^\.\/+/, '');
    return prefix === '.' ? '' : prefix;
  }

  private registerTaskAbortController(taskId: string): AbortController {
    const controller = new AbortController();
    const controllers = this.taskAbortControllers.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.taskAbortControllers.set(taskId, controllers);
    return controller;
  }

  private unregisterTaskAbortController(taskId: string, controller: AbortController): void {
    const controllers = this.taskAbortControllers.get(taskId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this.taskAbortControllers.delete(taskId);
  }

  private preApprovalDecisionPrompt(
    task: ReturnType<YanxuStore['getTask']>,
    project: ReturnType<YanxuStore['getProject']>,
    hasRequirementAgent: boolean,
    revisionFeedback?: string,
  ): string {
    return `你是研序的全局计划协调器。先决定用户确认计划前是否需要调用正式 Skill 生成产物；这里只做选择，不生成计划、不读取文件、不执行命令，也不得调用任何工具、联网搜索或网页抓取。

当前一期可选的确认前 Skill 只有 requirement-specification。以下情况通常需要它：新功能或新项目研发、会改变产品行为的改动、需求存在范围或验收歧义、用户要求修改已经生成的需求/计划。以下情况通常可以跳过：目标和验收已经非常明确的纯测试、纯评审、机械性维护或单纯文档整理。

先按任务语义决定是否需要 requirement-specification，不要因为系统里存在该 Skill 就固定选择它。即使 selectedTeamHasRequirementAgent=false，只要任务确实需要该 Skill 也应选择；研序会把它转成明确的团队能力缺口并阻止确认，不能用协调器静默替代。

${JSON.stringify({
      task: {
        title: task.title,
        description: task.description,
        expectedOutput: task.expectedOutput,
        constraints: task.constraints,
      },
      project: {
        name: project.name,
        description: project.description,
        directories: project.directories.map((directory) => ({
          id: directory.id,
          name: directory.displayName,
          contentTypes: directory.contentTypes,
          stack: directory.stack,
        })),
      },
      selectedTeamHasRequirementAgent: hasRequirementAgent,
      revisionFeedback: revisionFeedback ?? null,
      previousPlan: task.plan,
    }, null, 2)}`;
  }

  private planPrompt(
    task: ReturnType<YanxuStore['getTask']>,
    project: ReturnType<YanxuStore['getProject']>,
    requirementSpec: string | null,
    preApprovalSkillIds: string[],
    revisionFeedback?: string,
    preservePreviousSteps = false,
  ): string {
    const builtins = this.store.getBuiltins();
    const team = this.store.getTeam(task.teamId);
    const evidence = this.store.getTaskEvidence(task.id);
    const teamAgents = this.store.listAgents().filter((agent) => team.memberIds.includes(agent.id)).map((agent) => {
      const role = builtins.roles.find((item) => item.id === agent.roleId);
      return {
        id: agent.id,
        name: agent.name,
        roleId: agent.roleId,
        executor: agent.executor,
        model: agent.model,
        roleName: role?.name ?? agent.roleId,
        responsibilities: role?.responsibilities ?? [],
        skillIds: role?.skillIds ?? [],
        roleInstructions: role?.instructions ?? '',
        recommendedCapabilityIds: role?.capabilityIds ?? [],
        agentDefaultCapabilityIds: agent.defaultCapabilityIds,
        roleCompatibility: role?.compatibility ?? [],
      };
    });
    const projectCapabilities = this.store.listProjectCapabilities(project.id)
      .filter((item) => item.enabled)
      .map((item) => ({
        id: item.capabilityId,
        name: item.capability.name,
        kind: item.capability.kind,
        description: item.capability.description,
        version: item.lockedVersion,
        compatibility: item.capability.compatibility,
        credentialReady: item.capability.credentialRefs.every((name) => Boolean(process.env[name])),
        security: {
          fileCount: item.capability.security.files.length,
          executableFiles: item.capability.security.executableFiles,
          networkHosts: item.capability.security.networkHosts,
          containsLiteralSecrets: item.capability.security.containsLiteralSecrets,
        },
      }));
    const input = {
      task: {
        title: task.title,
        description: task.description,
        expectedOutput: task.expectedOutput,
        constraints: task.constraints,
        forbiddenPaths: task.forbiddenPaths,
        attachments: evidence.attachments.map((attachment) => ({
          fileName: attachment.fileName,
          contentHash: attachment.contentHash,
          size: attachment.size,
          content: attachment.contentPreview,
          truncated: attachment.contentTruncated,
        })),
      },
      project: { name: project.name, description: project.description, settings: this.store.getProjectSettings(project.id), directories: project.directories.map((directory) => ({
        id: directory.id, name: directory.displayName, path: directory.selectedPath, contentTypes: directory.contentTypes, stack: directory.stack,
        commands: directory.commands, branch: directory.currentBranch, branches: directory.localBranches, dirty: directory.isDirty,
      })) },
      retrievedProjectContext: this.store.buildPlanningContext(
        project.id,
        [task.title, task.description, task.expectedOutput, task.constraints, revisionFeedback ?? ''].join('\n'),
      ),
      team: { id: team.id, name: team.name, agents: teamAgents },
      projectCapabilities,
      requirementSpec,
      preApprovalSkillIds,
      availableExecutionSkills: builtins.skills.filter((skill) => skill.id !== 'requirement-specification').map((skill) => ({
        id: skill.id,
        roleId: skill.roleId,
        description: skill.description,
        inputs: skill.inputs,
        outputs: skill.outputs,
      })),
      activeProjectKnowledge: this.store.listKnowledge(project.id).filter((item) => item.status === 'active').slice(0, 20)
        .map((item) => ({ category: item.category, title: item.title, content: item.content })),
      executionEvidence: {
        artifacts: evidence.artifacts.filter((item) => item.status !== 'superseded').map((item) => ({
          type: item.artifactType,
          title: item.title,
          version: item.version,
          hash: item.contentHash,
        })),
        changes: evidence.changeManifests.slice(-8).map((item) => ({
          stepId: item.stepId,
          directoryId: item.directoryId,
          files: item.files.slice(0, 100),
          outOfScope: item.hasOutOfScopeChanges,
          sensitive: item.hasSensitiveChanges,
        })),
        gates: evidence.gateAttempts.slice(-6).map((item) => ({
          gateId: item.gateId,
          attempt: item.attempt,
          commandArgv: item.commandArgv,
          status: item.status,
          exitCode: item.exitCode,
          timedOut: item.timedOut,
          logExcerpt: readLogExcerpt(item.logPath),
        })),
        recentEvents: this.store.listEvents(task.id).slice(-16).map((event) => ({
          type: event.type,
          message: event.message,
          payload: event.payload,
        })),
      },
      previousPlan: task.plan,
      revisionFeedback: revisionFeedback ?? null,
      revisionPolicy: preservePreviousSteps ? 'preserve_step_skill_sequence' : 'allow_step_changes',
    };
    const requirementInstruction = requirementSpec
      ? '确认前的 RequirementSpec 已由需求规格 Skill 生成；必须以它为需求基线。'
      : '本任务未选择确认前 RequirementSpec；直接依据用户需求和项目事实规划。如果缺少产品人员导致无法可靠澄清范围，必须提出明确的歧义问题或能力缺口，不能自行补全。';
    if (task.flowVersion === 2) {
      return `你是研序的全局计划协调器。${requirementInstruction}你只生成可确认的任务计划，不修改文件、不执行项目命令、不联网，也不要把 Skill 当作固定流程阶段。

把任务拆成最小且足够的串行 WorkUnit。每个 WorkUnit 描述一个真实工作目标，而不是“调用某个 Skill”：
- team.agents 是候选人员池。结合人员的角色责任、执行器与模型能力选择 agentId；角色只影响分工建议，不构成硬性准入条件。没有合适人员时返回 null，由用户在确认计划时处理。
- requiredCapabilities 用自然语言描述完成工作所需的能力，不得填写角色名或内置 Skill ID；capabilityIds 只能从 projectCapabilities 中选择实际需要装载的能力 ID，也可以为空。人员的 agentDefaultCapabilityIds 和角色的 recommendedCapabilityIds 只是偏好，只有它们同时出现在 projectCapabilities 且确实有助于当前单元时才选择，不得偷偷补装或强行使用。
- 只能把与已选 agentId 的 executor 兼容且 credentialReady=true 的能力写入 capabilityIds；能力不决定角色，也不要求团队必须补充某类人员。
- mode 只有确需修改真实文件时才为 write；分析、评审和只读验证必须为 read_only。
- 只有需要避免上下文偏见的独立评审才设置 requiresIndependentSession=true；同一人员、同一 CLI 的连续相关工作默认复用会话。
- verification 写清该单元应如何核对，但真实项目命令必须同时进入 qualityGates，最终以实际退出码为准。
- 不固定要求产品、研发、测试、评审四段，也不固定产物格式；根据任务规模合并或省略不必要单元。
- directoryIds 只能使用 project.directories 中的 ID。qualityGates 优先复用项目已有命令，并使用结构化 commandArgv；禁止管道、重定向、命令替换、push、PR、部署。
- 歧义问题只问会改变范围、验收或技术路线的问题。每题给出 2–3 个互斥方案，推荐项第一且仅一个 recommended=true；界面另有自定义输入，不要生成“其他”。
- previousPlan 已回答的问题必须被吸收到计划，不要重复追问。${revisionFeedback ? '\n- 这是计划修改：逐条吸收 revisionFeedback，保留未被要求改变的有效内容。' : ''}${preservePreviousSteps ? '\n- 本次只吸收歧义答案：保持 previousPlan.steps 的数量、顺序和工作目标，只完善说明、人员、目录、能力和验证。' : ''}

规划硬性校验：
- 新建子项目时，qualityGates 的命令自身必须显式定位子目录，例如 npm --prefix <子目录> run test。
- commandArgv 每个 token 独立成项，不能合并 shell 表达式。
- 可自动验证的业务逻辑必须有真实 test 门禁；typecheck、lint、build 不能代替业务测试。
- 金额、价格、余额或预算必须采用整数最小货币单位或明确的十进制定点方案；禁止把 JavaScript number + toFixed 当作精度保证。

${JSON.stringify({ ...input, availableExecutionSkills: undefined }, null, 2)}`;
    }
    return `你是研序的全局计划协调器。${requirementInstruction}你负责组合可确认的执行计划，不修改任何文件，不执行项目命令，不得调用任何工具、联网搜索或网页抓取，也不要把 requirement-specification 再列入执行步骤。

基于下面的确认前产物、项目事实、已确认知识、可用执行 Skill 和指定团队，组合最小且足够的串行 ExecutionPlan。不要固定输出全部步骤：只选择完成当前任务真正需要的 Skill，可以省略不相关的研发、测试或评审步骤。每个步骤只能分配给 team.agents 中拥有该 Skill 的人员；没有可用人员时 agentId 返回 null。directoryIds 只能使用 project.directories 中的 ID。歧义问题只问会实质改变范围、验收或技术路线的问题。提出问题前必须先分析并给出 2–3 个互斥、可直接执行的方案：推荐方案放在第一项且只能有一个 recommended=true；label 要简短；description 说明选择后的影响或取舍；value 是可直接吸收到计划里的完整答案。不要把“自行填写”作为方案，界面会统一提供自定义方案。权限只列完成任务实际需要的能力。qualityGates 应优先复用 project.directories.commands；命令必须拆成 commandArgv，禁止 shell 管道、重定向、命令替换或远程发布。用户确认计划后这些门禁才可执行。previousPlan 中已经回答的歧义必须真正反映到目标、范围、成功标准、步骤、目录、权限或门禁中；不要原样重复已经解决的问题，只有答案仍引出新的关键歧义时才能继续提问。${revisionFeedback ? '\n\n这是一次计划修改。必须逐条处理 revisionFeedback，并以 previousPlan 为基线保留未被要求改变的有效内容；不要把修改请求忽略或只写进风险。' : ''}${preservePreviousSteps ? '\n\n本次修改只用于吸收用户对歧义问题的回答：不得增删、替换或重排 previousPlan.steps 的 Skill 序列；可以在同一 Skill 内完善标题、说明、输入、产出、人员与目录。' : ''}

规划硬性校验：
- 若任务会在关联目录下新建子项目，所有 qualityGates 必须通过命令自身显式定位到子项目（例如 npm --prefix <子目录> run test），不能假设门禁执行器会自动切换到新子目录。
- commandArgv 的每个命令行 token 必须是独立数组元素，例如 test ! -f app/.env 应写为 ["test","!","-f","app/.env"]，不得把 "! -f app/.env" 合成一个参数。
- 敏感文件改动已由研序在 checkpoint 前独立检查；revisionFeedback 若来自 sensitive_change，只需把相关文件从计划产出中移除，不要额外增加仅检查文件不存在的 shell 门禁。
- 产品研发中只要存在可自动验证的业务逻辑，就必须规划对应测试框架、测试文件和可执行 test 门禁；typecheck、lint、build 不能代替业务测试。
- 涉及金额、价格、余额或预算时，必须使用整数最小货币单位或明确的十进制定点方案；禁止把 JavaScript number + toFixed 当作精度保证。

${JSON.stringify(input, null, 2)}`;
  }

  private requirementPrompt(
    task: ReturnType<YanxuStore['getTask']>,
    project: ReturnType<YanxuStore['getProject']>,
    skill: SkillDefinition,
    revisionFeedback?: string,
  ): string {
    const evidence = this.store.getTaskEvidence(task.id);
    const previousAnswers = task.plan?.questions
      .filter((question) => question.answer?.trim())
      .map((question) => ({ question: question.question, answer: question.answer })) ?? [];
    const input = {
      task: {
        title: task.title,
        description: task.description,
        expectedOutput: task.expectedOutput,
        constraints: task.constraints,
        forbiddenPaths: task.forbiddenPaths,
        attachments: evidence.attachments.map((attachment) => ({
          fileName: attachment.fileName,
          contentHash: attachment.contentHash,
          size: attachment.size,
          content: attachment.contentPreview,
          truncated: attachment.contentTruncated,
        })),
      },
      project: {
        name: project.name,
        description: project.description,
        settings: this.store.getProjectSettings(project.id),
        directories: project.directories.map((directory) => ({
          id: directory.id,
          name: directory.displayName,
          selectedPath: directory.selectedPath,
          contentTypes: directory.contentTypes,
          stack: directory.stack,
          commands: directory.commands,
          branch: directory.currentBranch,
          dirty: directory.isDirty,
        })),
      },
      retrievedProjectContext: this.store.buildPlanningContext(
        project.id,
        [task.title, task.description, task.expectedOutput, task.constraints, revisionFeedback ?? ''].join('\n'),
      ),
      activeProjectKnowledge: this.store.listKnowledge(project.id)
        .filter((item) => item.status === 'active')
        .slice(0, 20)
        .map((item) => ({ category: item.category, title: item.title, content: item.content })),
      previousAnswers,
      previousRequirementSpec: evidence.preApprovalArtifacts
        .filter((artifact) => artifact.artifactType === 'requirement-spec')
        .at(-1)?.content ?? null,
      revisionFeedback: revisionFeedback ?? null,
    };
    return `你正在研序中执行内置 Skill“${skill.name}”。这是用户确认计划前的正式需求规格步骤，只分析并返回结构化结果，不读取或修改本地文件，不执行命令，也不得调用任何工具、联网搜索或网页抓取。\n\nRequirementSpec 的 Markdown 必须包含：背景与目标、范围、非范围、用户可验收的成功标准、约束、项目目录影响、明确假设、风险、仍需用户回答的歧义。已有回答必须被吸收到规格正文，不能继续作为未解决问题重复提出。若是修改计划，必须逐条吸收 revisionFeedback，并明确规格相较上一版的变化。completionChecks 必须逐项给出可追溯证据。\n\n结果状态规则：${nonBlockingSkillOutcomeGuidance(skill)} ${requirementRevisionGuidance(revisionFeedback)}\n\n${JSON.stringify(input, null, 2)}`;
  }
}

function readLogExcerpt(path: string): string {
  try {
    const content = readFileSync(path, 'utf8');
    return content.slice(Math.max(0, content.length - 8_000));
  } catch {
    return '';
  }
}

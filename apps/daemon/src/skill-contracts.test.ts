import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@yanxu/contracts';
import { permissionRules } from '@yanxu/executors';
import {
  nonBlockingSkillOutcomeGuidance,
  normalizeSkillResultOutcome,
  requirementRevisionGuidance,
  skillResultSchema,
  validateSkillResult,
  type SkillResult,
} from './scheduler.js';

const reviewSkill: SkillDefinition = {
  id: 'delivery-review',
  name: '交付评审',
  roleId: 'review',
  description: '核对交付证据。',
  inputs: ['RequirementSpec', 'ChangeManifest', 'GateResult'],
  outputs: ['DeliveryReview'],
  artifactTypes: ['delivery-review'],
  completionChecks: ['结论引用实际证据', '偏差和限制未被隐藏'],
  permissions: ['workspace.read'],
  canBlockDelivery: true,
  version: '1.0.0',
};

const implementationSkill: SkillDefinition = {
  id: 'implementation',
  name: '内容实施',
  roleId: 'development',
  description: '在隔离工作区实施变更。',
  inputs: ['TechnicalPlan'],
  outputs: ['代码变更'],
  artifactTypes: ['implementation-report'],
  completionChecks: ['变更位于批准范围', '实际文件清单可由 Git 重建'],
  permissions: ['workspace.write', 'command.execute'],
  canBlockDelivery: false,
  version: '1.0.0',
};

function result(patch: Partial<SkillResult> = {}): SkillResult {
  return {
    status: 'succeeded',
    summary: '评审通过。',
    artifacts: [{ type: 'delivery-review', content: '# Review\n\n证据完整。' }],
    issues: [],
    assumptions: [],
    requestedScopeChanges: [],
    reportedChecks: [],
    completionChecks: [
      { check: '结论引用实际证据', status: 'passed', evidence: '引用 GateAttempt 1。' },
      { check: '偏差和限制未被隐藏', status: 'passed', evidence: '风险章节已核对。' },
    ],
    ...patch,
  };
}

describe('skill output contracts', () => {
  it('binds the structured output schema to the skill artifact and completion contracts', () => {
    const schema = skillResultSchema(reviewSkill) as {
      required: string[];
      properties: {
        status: { enum: string[] };
        artifacts: { items: { properties: { type: { enum: string[] } } } };
        completionChecks: { items: { properties: { check: { enum: string[] } } } };
      };
    };
    expect(schema.properties.status.enum).toEqual(['succeeded', 'changes_required', 'blocked']);
    expect(schema.properties.artifacts.items.properties.type.enum).toEqual(['delivery-review']);
    expect(schema.properties.completionChecks.items.properties.check.enum).toEqual(reviewSkill.completionChecks);
    expect(schema.required).toContain('findings');
  });

  it('does not offer changes_required to a non-blocking skill', () => {
    const schema = skillResultSchema(implementationSkill) as {
      properties: { status: { enum: string[] } };
    };
    expect(schema.properties.status.enum).toEqual(['succeeded', 'blocked']);
    expect(nonBlockingSkillOutcomeGuidance(implementationSkill)).toContain('不能返回 changes_required');
  });

  it('treats sensitive files as forbidden output during requirement replanning', () => {
    const guidance = requirementRevisionGuidance(
      '执行工作区检测到敏感文件改动：dir-a:yanxu-h5/.env.production。请生成需要用户重新确认的修订计划。',
    );
    expect(guidance).toContain('形成新版规格后返回 succeeded');
    expect(guidance).toContain('从需求范围、目录影响和后续实现清单中彻底移除');
    expect(guidance).toContain('内容白名单、示例值或用户审批重新纳入');
    expect(guidance).toContain('禁止用另一个 .env 变体替代');
    expect(guidance).toContain('src/config/app.ts');
    expect(requirementRevisionGuidance('保留所有 .env* 文件不得作为实现产出的修订。'))
      .toContain('最终 RequirementSpec 的计划产出路径中不得出现任何 .env 文件');
  });

  it('rejects a nominal success that omits required evidence or fails a completion check', () => {
    expect(() => validateSkillResult(reviewSkill, result({ artifacts: [{ type: 'other', content: 'wrong' }] })))
      .toThrow('缺少必需产物');
    expect(() => validateSkillResult(reviewSkill, result({
      completionChecks: [
        { check: '结论引用实际证据', status: 'failed', evidence: '没有 GateResult。' },
        { check: '偏差和限制未被隐藏', status: 'passed', evidence: '已检查。' },
      ],
    }))).toThrow('不能在完成条件失败时返回成功');
  });

  it('allows a blocking review to return changes_required with explicit failed evidence', () => {
    expect(() => validateSkillResult(reviewSkill, result({
      status: 'changes_required',
      summary: '缺少回归测试。',
      issues: ['AC-2 没有对应测试'],
      completionChecks: [
        { check: '结论引用实际证据', status: 'passed', evidence: '引用 GateAttempt 1。' },
        { check: '偏差和限制未被隐藏', status: 'failed', evidence: 'AC-2 缺口。' },
      ],
    }))).not.toThrow();
  });

  it('forces a delivery review with reported issues into the correction flow', () => {
    const reviewed = result({
      status: 'succeeded',
      summary: '评审声称通过。',
      issues: ['代码示例缺少必要导入，无法直接运行。'],
    });

    expect(() => validateSkillResult(reviewSkill, reviewed)).toThrow('仍报告待处理问题时不能返回成功');
    expect(normalizeSkillResultOutcome(reviewSkill, reviewed)).toMatchObject({
      status: 'changes_required',
      issues: ['代码示例缺少必要导入，无法直接运行。'],
    });
    expect(() => validateSkillResult(reviewSkill, normalizeSkillResultOutcome(reviewSkill, reviewed))).not.toThrow();
  });

  it('allows non-blocking structured review advice without hiding it', () => {
    const reviewed = normalizeSkillResultOutcome(reviewSkill, result({
      findings: [{
        severity: 'minor',
        category: 'maintainability',
        title: '可提取重复常量',
        description: '不影响当前验收，但后续可以降低维护成本。',
        evidence: 'src/example.ts 中出现两次相同常量。',
        location: 'src/example.ts',
        recommendation: '后续重构时提取常量。',
        blocking: false,
      }],
    }));
    expect(reviewed).toMatchObject({ status: 'succeeded' });
    expect(reviewed.findings).toHaveLength(1);
    expect(() => validateSkillResult(reviewSkill, reviewed)).not.toThrow();
  });

  it('keeps legacy issues blocking even when structured advice is also present', () => {
    const reviewed = normalizeSkillResultOutcome(reviewSkill, result({
      issues: ['运行时错误仍未修复。'],
      findings: [{
        severity: 'minor', category: 'maintainability', title: '命名可优化', description: '不影响验收。',
        evidence: 'src/example.ts', recommendation: '后续重命名。', blocking: false,
      }],
    }));
    expect(reviewed.status).toBe('changes_required');
    expect(reviewed.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'major', blocking: true, description: '运行时错误仍未修复。' }),
    ]));
  });

  it('compiles confirmed workspace and command boundaries into runtime allows', () => {
    const rules = permissionRules('standard', false, {
      allowedReadPatterns: ['dir-a/**'],
      allowedEditPatterns: ['dir-a/**'],
      allowedBashPatterns: ['pnpm test'],
      taskGrants: [],
      forbiddenReadPatterns: ['dir-a/private/**'],
    }) as Array<{ permission: string; pattern: string; action: string }>;
    expect(rules).toContainEqual({ permission: 'edit', pattern: 'dir-a/**', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: 'pnpm test', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'read', pattern: 'dir-a/private/**', action: 'deny' });
    expect(rules).not.toContainEqual({ permission: 'bash', pattern: 'pnpm install', action: 'allow' });
  });

  it('rejects unplanned permissions without pausing when an agent uses managed mode', () => {
    const standard = permissionRules('standard', false) as Array<{ permission: string; pattern: string; action: string }>;
    const managed = permissionRules('managed', false) as Array<{ permission: string; pattern: string; action: string }>;

    expect(standard[0]).toEqual({ permission: '*', pattern: '*', action: 'ask' });
    expect(managed[0]).toEqual({ permission: '*', pattern: '*', action: 'deny' });
    expect(standard).not.toContainEqual({ permission: 'edit', pattern: '*', action: 'deny' });
    expect(managed).not.toContainEqual({ permission: 'edit', pattern: '*', action: 'ask' });
  });

  it('can permanently deny network and dependency installation at the runtime policy layer', () => {
    const rules = permissionRules('standard', false, {
      allowedReadPatterns: [],
      allowedEditPatterns: [],
      allowedBashPatterns: [],
      taskGrants: [],
      forbiddenReadPatterns: [],
      networkPolicy: 'deny',
      dependencyInstallPolicy: 'deny',
    }) as Array<{ permission: string; pattern: string; action: string }>;
    expect(rules).toContainEqual({ permission: 'webfetch', pattern: '*', action: 'deny' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: 'curl *', action: 'deny' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: 'pnpm install*', action: 'deny' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: 'npm --prefix * install*', action: 'deny' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: 'pip install *', action: 'deny' });
  });

  it('lets an implementation report an actionable runtime block but not request downstream correction', () => {
    const blocked: SkillResult = {
      status: 'blocked',
      summary: '依赖安装被运行时拒绝。',
      artifacts: [{ type: 'implementation-report', content: '# Implementation\n\n现场已保留。' }],
      issues: ['计划批准的 npm install 没有进入运行时白名单。'],
      assumptions: [],
      requestedScopeChanges: [],
      reportedChecks: [],
      completionChecks: [
        { check: '变更位于批准范围', status: 'passed', evidence: 'Git 状态仅包含批准目录。' },
        { check: '实际文件清单可由 Git 重建', status: 'failed', evidence: '尚未形成 checkpoint。' },
      ],
    };

    expect(() => validateSkillResult(implementationSkill, blocked)).not.toThrow();
    expect(() => validateSkillResult(implementationSkill, { ...blocked, issues: [] }))
      .toThrow('必须说明可操作的阻塞原因');
    expect(() => validateSkillResult(implementationSkill, { ...blocked, status: 'changes_required' }))
      .toThrow('不能要求下游整改');
  });

  it('requires test design to return structured task-specific gate metadata', () => {
    const testDesign: SkillDefinition = {
      id: 'test-design',
      name: '测试设计',
      roleId: 'testing',
      description: '形成可执行测试范围。',
      inputs: ['RequirementSpec'],
      outputs: ['TestPlan'],
      artifactTypes: ['test-plan'],
      completionChecks: ['覆盖成功标准'],
      permissions: ['workspace.read'],
      canBlockDelivery: false,
      version: '1.0.0',
    };
    const schema = skillResultSchema(testDesign) as {
      properties: { artifacts: { items: { required: string[] } } };
    };
    expect(schema.properties.artifacts.items.required).toContain('metadata');
  });
});

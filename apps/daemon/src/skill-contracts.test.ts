import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@yanxu/contracts';
import { permissionRules } from '@yanxu/executors';
import { normalizeSkillResultOutcome, skillResultSchema, validateSkillResult, type SkillResult } from './scheduler.js';

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
      properties: {
        artifacts: { items: { properties: { type: { enum: string[] } } } };
        completionChecks: { items: { properties: { check: { enum: string[] } } } };
      };
    };
    expect(schema.properties.artifacts.items.properties.type.enum).toEqual(['delivery-review']);
    expect(schema.properties.completionChecks.items.properties.check.enum).toEqual(reviewSkill.completionChecks);
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
    expect(rules).toContainEqual({ permission: 'bash', pattern: 'pip install *', action: 'deny' });
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

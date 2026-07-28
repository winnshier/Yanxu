import type { RoleTemplate, SkillDefinition } from '@yanxu/contracts';

export const builtinRoles: RoleTemplate[] = [
  {
    id: 'product', name: '产品', description: '澄清目标与边界，把自然语言需求固化为可确认、可验证的规格。',
    responsibilities: ['识别歧义与风险', '维护需求版本', '定义成功标准与非范围'],
    skillIds: ['requirement-specification'], defaultPermissions: ['读取项目资料', '写入 ProjectSpace 需求产物'], version: '1.0.0',
  },
  {
    id: 'development', name: '研发', description: '基于已批准计划设计并实施变更，持续形成可恢复的 Git checkpoint。',
    responsibilities: ['技术方案设计', '内容实施', '维护变更清单'], skillIds: ['technical-design', 'implementation'],
    defaultPermissions: ['读取项目目录', '写任务 worktree', '执行项目命令'], version: '1.0.0',
  },
  {
    id: 'testing', name: '测试', description: '从需求和实际变更建立测试范围，执行可复现的质量检查。',
    responsibilities: ['测试设计', '测试执行', '记录失败证据'], skillIds: ['test-design', 'test-execution'],
    defaultPermissions: ['读取任务 worktree', '执行测试与检查命令'], version: '1.0.0',
  },
  {
    id: 'review', name: '评审', description: '独立核对需求、实现、测试与风险，生成结构化交付结论。',
    responsibilities: ['审查变更', '核对门禁证据', '识别偏差与遗留风险'], skillIds: ['delivery-review'],
    defaultPermissions: ['只读项目目录与任务产物', '写入评审报告'], version: '1.0.0',
  },
];

export const builtinSkills: SkillDefinition[] = [
  {
    id: 'requirement-specification', name: '需求分析与规格化', roleId: 'product', description: '把需求整理为目标、范围、非范围、歧义、风险和成功标准。',
    inputs: ['用户需求', '项目认知', '相关历史决策'], outputs: ['RequirementSpec', '歧义问题'], artifactTypes: ['requirement-spec'],
    completionChecks: ['目标与成功标准可验证', '歧义已显式列出'],
    permissions: ['project.read', 'projectspace.write'], canBlockDelivery: false, version: '1.0.0',
  },
  {
    id: 'technical-design', name: '技术方案设计', roleId: 'development', description: '将批准的需求映射到项目目录、代码边界、分支和质量门禁。',
    inputs: ['RequirementSpec', 'DirectoryProfile'], outputs: ['TechnicalPlan'], artifactTypes: ['technical-plan'],
    completionChecks: ['列出影响范围', '列出验证路径'],
    permissions: ['workspace.read', 'projectspace.write'], canBlockDelivery: false, version: '1.0.0',
  },
  {
    id: 'implementation', name: '内容实施', roleId: 'development', description: '在隔离 worktree 中实现批准的技术方案并保存 checkpoint。',
    inputs: ['TechnicalPlan', 'ContextPack'], outputs: ['代码或文档变更', '实现摘要'], artifactTypes: ['implementation-report'],
    completionChecks: ['变更位于批准范围', '实际文件清单可由 Git 重建'],
    permissions: ['workspace.write', 'command.execute'], canBlockDelivery: false, version: '1.0.0',
  },
  {
    id: 'test-design', name: '测试设计', roleId: 'testing', description: '根据需求、项目能力和实际变更框定测试范围。',
    inputs: ['RequirementSpec', 'ChangeManifest'], outputs: ['TestPlan'], artifactTypes: ['test-plan'],
    completionChecks: ['覆盖成功标准', '标明豁免与风险'],
    permissions: ['workspace.read', 'projectspace.write'], canBlockDelivery: false, version: '1.0.0',
  },
  {
    id: 'test-execution', name: '测试执行', roleId: 'testing', description: '执行项目已有门禁和专项检查，保存命令、退出码与日志。',
    inputs: ['TestPlan', 'QualityGatePlan'], outputs: ['GateResult', '测试报告'], artifactTypes: ['test-report'],
    completionChecks: ['所有非豁免门禁有结果', '失败有可复现证据'],
    permissions: ['workspace.read', 'command.execute'], canBlockDelivery: true, version: '1.0.0',
  },
  {
    id: 'delivery-review', name: '交付评审', roleId: 'review', description: '独立验证需求完成度、实际改动、门禁和风险。',
    inputs: ['所有任务产物', 'ChangeManifest', 'GateResult'], outputs: ['DeliveryReview', '知识候选'], artifactTypes: ['delivery-review'],
    completionChecks: ['结论引用实际证据', '偏差和限制未被隐藏'],
    permissions: ['workspace.read', 'projectspace.write'], canBlockDelivery: true, version: '1.0.0',
  },
];

export const defaultExecutionSkillIds = [
  'technical-design', 'implementation', 'test-design', 'test-execution', 'delivery-review',
] as const;

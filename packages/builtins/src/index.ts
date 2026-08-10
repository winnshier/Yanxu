import type { RoleTemplate } from '@yanxu/contracts';

const builtinRoleMetadata = {
  origin: 'builtin' as const,
  lifecycleStatus: 'builtin' as const,
  parseStatus: 'valid' as const,
  parseError: null,
  instructions: '',
  capabilityIds: [],
  dependencyNames: [],
  compatibility: ['opencode', 'claude'] as RoleTemplate['compatibility'],
  source: { type: 'builtin' as const, scope: 'managed' as const, executor: null, ref: 'yanxu://builtin-roles', version: '1.0.0' },
  contentHash: 'builtin-1.0.0',
  format: 'yanxu-builtin',
  managedPath: null,
  createdAt: null,
  updatedAt: null,
};

export const builtinRoles: RoleTemplate[] = [
  {
    ...builtinRoleMetadata,
    id: 'product', name: '产品', description: '澄清目标与边界，把自然语言需求固化为可确认、可验证的规格。',
    responsibilities: ['识别歧义与风险', '维护需求版本', '定义成功标准与非范围'],
    defaultPermissions: ['读取项目资料', '写入 ProjectSpace 需求产物'], version: '1.0.0',
  },
  {
    ...builtinRoleMetadata,
    id: 'development', name: '研发', description: '基于已批准计划设计并实施变更，持续形成可恢复的 Git checkpoint。',
    responsibilities: ['技术方案设计', '内容实施', '维护变更清单'],
    defaultPermissions: ['读取项目目录', '写任务 worktree', '执行项目命令'], version: '1.0.0',
  },
  {
    ...builtinRoleMetadata,
    id: 'testing', name: '测试', description: '从需求和实际变更建立测试范围，执行可复现的质量检查。',
    responsibilities: ['测试设计', '测试执行', '记录失败证据'],
    defaultPermissions: ['读取任务 worktree', '执行测试与检查命令'], version: '1.0.0',
  },
  {
    ...builtinRoleMetadata,
    id: 'review', name: '评审', description: '独立核对需求、实现、测试与风险，生成结构化交付结论。',
    responsibilities: ['审查变更', '核对门禁证据', '识别偏差与遗留风险'],
    defaultPermissions: ['只读项目目录与任务产物', '写入评审报告'], version: '1.0.0',
  },
];

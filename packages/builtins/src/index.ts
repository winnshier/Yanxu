import type { ExecutorType, RoleTemplate } from '@yanxu/contracts';

export interface BuiltinSkillDefinition {
  id: string;
  name: string;
  title: string;
  description: string;
  pack: 'common' | 'development';
  compatibility: ExecutorType[];
  content: string;
}

interface SkillInput {
  name: string;
  title: string;
  description: string;
  pack: BuiltinSkillDefinition['pack'];
  steps: string[];
  outputs: string[];
  guardrails?: string[];
}

const builtinVersion = '2.0.0';
const compatibility: ExecutorType[] = ['opencode', 'claude'];

export function builtinSkillId(name: string): string {
  return `builtin-skill-${name}`;
}

function createSkill(input: SkillInput): BuiltinSkillDefinition {
  const section = (title: string, values: string[]) => `## ${title}\n\n${values.map((item) => `- ${item}`).join('\n')}`;
  const content = `---
name: ${input.name}
description: ${input.description}
---

# ${input.title}

${section('执行方法', input.steps)}

${section('产出要求', input.outputs)}

${section('边界', [
    '只处理当前目标和已授权范围，不能把建议或推测伪装成已完成事实。',
    '缺少必要输入、工具或权限时，说明具体缺口和可继续的最小条件。',
    ...(input.guardrails ?? []),
  ])}
`;
  return {
    id: builtinSkillId(input.name),
    name: input.name,
    title: input.title,
    description: input.description,
    pack: input.pack,
    compatibility,
    content,
  };
}

const commonSkills: BuiltinSkillDefinition[] = [
  createSkill({
    name: 'task-intake', title: '任务受理', pack: 'common',
    description: '将用户的自然语言请求整理成目标、交付物、约束、已知事实和待确认问题。用于接收新任务或修订已有任务。',
    steps: ['识别用户真正要解决的问题与期望结果。', '区分明确事实、合理假设、约束和未知项。', '只提出会实质影响方案或验收的必要问题。'],
    outputs: ['给出可直接用于计划的任务摘要。', '列出交付物、成功标准、非范围和待确认项。'],
  }),
  createSkill({
    name: 'task-planning', title: '任务规划', pack: 'common',
    description: '把已澄清目标拆成有依赖关系、责任边界和验证方式的可执行工作单元。用于复杂任务开始前的计划制定。',
    steps: ['根据目标和风险选择最小必要工作单元。', '标明依赖、输入、预期结果和验证方式。', '合并没有独立价值的步骤，暴露需要人工确认的边界。'],
    outputs: ['形成顺序明确、可中止、可恢复的执行计划。', '为每个工作单元定义完成条件。'],
  }),
  createSkill({
    name: 'web-research', title: '网络研究', pack: 'common',
    description: '围绕明确问题检索公开信息并建立来源清单。用于需要最新资料、外部事实或方案对比的任务。',
    steps: ['先定义研究问题、时间范围和可信来源优先级。', '优先读取原始、官方或一手来源并交叉核对关键结论。', '记录发布日期、适用范围和仍不确定的内容。'],
    outputs: ['输出带来源的研究结论和证据索引。', '明确区分来源事实、推断和建议。'],
    guardrails: ['无法联网或来源不可访问时不得凭记忆伪造引用。'],
  }),
  createSkill({
    name: 'source-verification', title: '来源核验', pack: 'common',
    description: '核对引用是否真实支持结论，并检查时效、权威性和相互矛盾。用于研究、文档和交付前的事实复核。',
    steps: ['逐项映射结论与实际来源。', '检查来源身份、日期、上下文和适用条件。', '对冲突证据给出差异原因或保留不确定结论。'],
    outputs: ['标记已验证、证据不足和存在冲突的结论。', '保留可定位的来源地址或文档位置。'],
  }),
  createSkill({
    name: 'knowledge-synthesis', title: '知识综合', pack: 'common',
    description: '从多份资料中提炼共识、差异、关键决策和可复用知识。用于调研总结、项目认知更新或方案选择。',
    steps: ['按主题归并材料并去除重复信息。', '识别共识、差异、条件和证据强弱。', '将结论转换为面向当前目标的决策信息。'],
    outputs: ['形成结构化摘要、关键结论和未决问题。', '保留结论到来源的可追溯关系。'],
  }),
  createSkill({
    name: 'document-authoring', title: '文档撰写', pack: 'common',
    description: '根据目标、受众和素材创建结构清晰的文档初稿。用于报告、说明、方案、规范和其他文字交付。',
    steps: ['确认受众、目的、文档类型和必要章节。', '用事实和清晰逻辑组织正文。', '统一术语、层级、语气和格式。'],
    outputs: ['交付完整文档及必要的摘要。', '标注仍需补充或确认的内容。'],
  }),
  createSkill({
    name: 'document-editing', title: '文档编辑', pack: 'common',
    description: '对现有文档进行结构、逻辑、表达和一致性修订。用于改写、压缩、扩写、校对或按反馈更新文档。',
    steps: ['先理解原文意图、受众和不可改变的信息。', '修复结构、逻辑、歧义、重复和表达问题。', '复核修改是否引入事实偏差或遗漏。'],
    outputs: ['交付修订后的文档。', '必要时概括关键变化和仍存在的问题。'],
  }),
  createSkill({
    name: 'spreadsheet-processing', title: '表格处理', pack: 'common',
    description: '读取、清洗、计算、整理和输出电子表格。用于 CSV、XLSX 数据处理、公式维护和表格格式规范化。',
    steps: ['检查工作表、字段、数据类型、公式和缺失值。', '在保留原始数据语义的前提下执行转换与计算。', '复核关键公式、汇总值和输出结构。'],
    outputs: ['交付可继续编辑的表格文件或明确的数据结果。', '记录重要假设、异常数据和处理规则。'],
    guardrails: ['不要静默覆盖原始文件或把文本数字误当成可靠数值。'],
  }),
  createSkill({
    name: 'data-analysis', title: '数据分析', pack: 'common',
    description: '围绕业务或工作问题分析结构化数据并解释结果。用于统计汇总、趋势、异常、分组比较和决策支持。',
    steps: ['确认指标定义、分析粒度和数据质量。', '选择与问题匹配的分析方法并保留可复现过程。', '区分相关性、因果性、异常和样本限制。'],
    outputs: ['给出关键发现、证据和面向决策的解释。', '附上口径、限制和必要的明细或图表。'],
  }),
  createSkill({
    name: 'presentation-creation', title: '演示文稿制作', pack: 'common',
    description: '将信息组织成适合演示的叙事、页面和视觉层级。用于汇报、方案路演、培训和项目复盘。',
    steps: ['确定听众、演示目标、时长和核心结论。', '建立一页一重点的叙事结构。', '统一版式、视觉层级、图表和讲述顺序。'],
    outputs: ['交付可演示、可编辑的幻灯片。', '确保关键页面能独立表达结论并标注数据来源。'],
  }),
  createSkill({
    name: 'pdf-processing', title: 'PDF 处理', pack: 'common',
    description: '读取、提取、整理、检查或生成 PDF 内容。用于 PDF 文本与表格提取、合并拆分、版面检查和交付。',
    steps: ['先确认任务需要保留文本、版式、表单还是图像。', '选择不会破坏目标内容的处理方式。', '渲染或抽查处理后的关键页面。'],
    outputs: ['交付目标 PDF 或结构化提取结果。', '说明无法可靠识别的扫描、字体或布局问题。'],
  }),
  createSkill({
    name: 'file-conversion', title: '文件转换', pack: 'common',
    description: '在常见文档、表格、演示、文本和数据格式之间转换，并尽量保持内容语义。用于批量或单文件格式迁移。',
    steps: ['识别源格式、目标格式和必须保留的特性。', '执行转换并记录不可映射的格式或功能。', '对转换前后内容、页数、字段或关键值进行核对。'],
    outputs: ['交付目标格式文件。', '列出格式损失、兼容性限制和需人工确认项。'],
  }),
  createSkill({
    name: 'knowledge-capture', title: '知识沉淀', pack: 'common',
    description: '把任务中的稳定事实、决策、经验和限制整理成可检索、可更新的项目知识。用于任务完成后沉淀认知。',
    steps: ['只提取经过结果验证且对后续任务有复用价值的内容。', '区分项目事实、决策、经验和待验证候选。', '发现旧知识不再准确时建立替代关系而不是简单叠加。'],
    outputs: ['形成短小、可检索、带来源的知识条目。', '说明适用条件、来源任务和失效条件。'],
  }),
  createSkill({
    name: 'browser-operation', title: '浏览器操作', pack: 'common',
    description: '在授权范围内使用浏览器完成页面访问、表单操作、信息采集和结果验证。用于需要网页交互的工作任务。',
    steps: ['确认目标站点、允许的操作和成功标志。', '按可回退的小步骤操作并记录关键状态。', '在提交、发送、购买或删除前检查是否需要人工确认。'],
    outputs: ['报告已完成操作、页面结果和必要证据。', '说明登录、验证码、权限或页面变化造成的阻塞。'],
    guardrails: ['不得绕过授权、验证码或站点安全限制。'],
  }),
  createSkill({
    name: 'desktop-file-operation', title: '桌面文件操作', pack: 'common',
    description: '在授权目录内整理、查找、移动、复制和命名本地文件。用于桌面工作区和项目资料的可追溯维护。',
    steps: ['先解析并核对准确目标路径和操作范围。', '优先使用可恢复操作并避免覆盖同名文件。', '操作后核对文件数量、位置和完整性。'],
    outputs: ['列出实际变更的文件和目录。', '说明未执行的危险、越界或含糊操作。'],
    guardrails: ['删除、覆盖、大范围移动或跨授权目录操作必须获得明确授权。'],
  }),
  createSkill({
    name: 'deliverable-review', title: '交付物审查', pack: 'common',
    description: '从正确性、完整性、可读性和目标符合度审查交付物。用于文档、表格、演示、代码或混合成果的独立检查。',
    steps: ['依据任务目标和成功标准逐项核对。', '检查内容、结构、事实、格式和可使用性。', '按严重度区分阻塞问题、改进项和可接受风险。'],
    outputs: ['给出通过、需修改或阻塞的明确结论。', '每个问题附带位置、证据和可操作建议。'],
  }),
  createSkill({
    name: 'final-verification', title: '最终验证', pack: 'common',
    description: '在交付前核对任务产出、实际操作、验证证据和遗留风险。用于任何任务的最后完成性检查。',
    steps: ['对照最终需求和已确认计划检查交付范围。', '复核实际文件、命令结果或可观察状态。', '确认没有把未执行、失败或不确定事项报告为成功。'],
    outputs: ['形成最终验证结论与证据摘要。', '明确列出遗留风险、人工验证项和后续动作。'],
  }),
];

const developmentSkills: BuiltinSkillDefinition[] = [
  createSkill({
    name: 'requirement-clarification', title: '需求澄清', pack: 'development',
    description: '澄清产品研发需求中的目标用户、业务行为、边界、歧义和约束。用于新功能、变更需求或需求修订。',
    steps: ['结合现有项目事实识别需求中的隐含假设。', '提出影响行为、范围、数据或验收的关键问题。', '把用户回答吸收到最新需求版本。'],
    outputs: ['形成无关键歧义的需求说明。', '记录范围、非范围、约束和仍需决策的问题。'],
  }),
  createSkill({
    name: 'feature-specification', title: '功能规格', pack: 'development',
    description: '把已澄清需求转成用户行为、业务规则、状态、异常和范围明确的功能规格。用于研发计划确认前。',
    steps: ['描述用户目标和主要使用流程。', '定义业务规则、状态变化、异常路径和跨系统影响。', '与项目现状核对术语、接口和约束。'],
    outputs: ['交付可由研发和测试共同理解的功能规格。', '标明依赖、非范围和待确认决策。'],
  }),
  createSkill({
    name: 'acceptance-criteria', title: '验收标准', pack: 'development',
    description: '为功能或变更定义可观察、可测试的通过条件。用于需求确认、计划制定和最终验收。',
    steps: ['从用户价值和关键风险提取验收场景。', '覆盖正常、边界、失败和权限路径。', '确保每条标准能够由证据判定通过或失败。'],
    outputs: ['给出明确的验收条件和预期结果。', '避免使用“基本正常”等不可验证表述。'],
  }),
  createSkill({
    name: 'codebase-exploration', title: '代码库探索', pack: 'development',
    description: '定位与需求相关的代码、配置、数据流、测试和项目约定。用于修改存量项目之前建立事实基础。',
    steps: ['从入口、符号、路由或配置开始定向检索。', '追踪关键调用、数据流和测试覆盖。', '记录现有约定、生成文件和不可直接修改区域。'],
    outputs: ['形成相关文件、关键符号和行为链路摘要。', '标明未知点、风险和推荐修改入口。'],
    guardrails: ['不要用完整重读仓库代替有目标的检索。'],
  }),
  createSkill({
    name: 'dependency-analysis', title: '依赖分析', pack: 'development',
    description: '分析模块、包、服务、数据和外部系统之间的依赖关系。用于技术方案、升级或变更风险判断。',
    steps: ['识别直接依赖、反向依赖和运行时依赖。', '核对版本、配置、构建与部署约束。', '区分必须同步修改和仅可能受影响的部分。'],
    outputs: ['列出依赖关系、兼容条件和风险。', '指出需要验证的接口、版本或环境。'],
  }),
  createSkill({
    name: 'change-impact-analysis', title: '变更影响分析', pack: 'development',
    description: '评估需求变更对代码、接口、数据、测试、文档和运行环境的影响。用于计划范围和回归范围制定。',
    steps: ['从目标行为反向追踪受影响组件。', '检查兼容性、数据迁移、并发和失败恢复风险。', '按确定影响、潜在影响和非影响区域分类。'],
    outputs: ['形成变更面、风险点和验证范围。', '明确需要隔离或人工确认的高风险改动。'],
  }),
  createSkill({
    name: 'architecture-design', title: '架构设计', pack: 'development',
    description: '针对研发目标设计组件边界、数据流、接口、状态和关键技术决策。用于跨模块或高风险变更。',
    steps: ['基于现有架构和非功能约束评估可选方案。', '明确组件职责、接口、数据所有权和失败处理。', '记录取舍、演进路径和不采用方案的原因。'],
    outputs: ['交付足以指导实现和评审的设计说明。', '列出关键决策、风险、兼容性和验证策略。'],
  }),
  createSkill({
    name: 'implementation-planning', title: '实现规划', pack: 'development',
    description: '把功能规格和技术设计转成贴合代码库的实现顺序、文件范围和验证方法。用于编码开始前。',
    steps: ['将需求行为映射到实际模块和符号。', '安排能保持中间状态可验证的修改顺序。', '为每组改动定义检查点和回退条件。'],
    outputs: ['给出文件或模块级实现计划。', '标明依赖、风险、测试和完成标准。'],
  }),
  createSkill({
    name: 'task-breakdown', title: '研发任务拆分', pack: 'development',
    description: '把研发计划拆成边界清晰、依赖明确且可独立验证的工作单元。用于多人、多仓库或复杂变更编排。',
    steps: ['按依赖、写入冲突、上下文和验证价值划分单元。', '确定串行关系和可安全并行的不同任务。', '避免按职位机械拆分没有独立结果的步骤。'],
    outputs: ['形成有顺序、负责人、输入输出和验证点的单元清单。', '标明共享文件和潜在合并冲突。'],
  }),
  createSkill({
    name: 'git-worktree-isolation', title: 'Git 工作区隔离', pack: 'development',
    description: '为任务建立、核对和维护独立 Git 分支与 worktree。用于并行需求、存量修改和安全交付。',
    steps: ['确认来源分支、来源提交和目标分支。', '在不改动用户原工作区的前提下准备隔离工作区。', '持续核对实际改动、基线漂移和合并冲突。'],
    outputs: ['记录任务分支、worktree、基线和变更状态。', '发现语义冲突时保留现场并请求处理。'],
    guardrails: ['不得擅自 push、改写远程历史或在未确认分支上合并。'],
  }),
  createSkill({
    name: 'code-implementation', title: '代码实现', pack: 'development',
    description: '依据已确认需求和计划在授权工作区内实现代码变更。用于新增功能、修复和项目构建。',
    steps: ['先读取相关代码和现有约定，再做最小完整实现。', '保持类型、错误处理、接口和数据行为一致。', '边实现边运行与当前改动最相关的检查。'],
    outputs: ['交付真实代码变更及文件清单。', '报告实际执行的检查、结果和未完成事项。'],
  }),
  createSkill({
    name: 'refactoring', title: '代码重构', pack: 'development',
    description: '在保持外部行为的前提下改善代码结构、边界和可维护性。用于技术债、重复逻辑或架构演进。',
    steps: ['先固定必须保持的行为和验证基线。', '以小步、可验证方式调整结构。', '删除失效路径并复核调用方、类型和测试。'],
    outputs: ['交付结构改进及行为保持证据。', '说明兼容性、迁移影响和刻意保留的技术债。'],
  }),
  createSkill({
    name: 'systematic-debugging', title: '系统化调试', pack: 'development',
    description: '基于复现、日志、状态和代码证据定位故障根因。用于运行失败、卡住、错误结果或不稳定问题。',
    steps: ['先稳定复现并记录期望与实际行为。', '沿状态、事件、输入和依赖逐层缩小范围。', '验证根因假设，再实施最小修复并回归。'],
    outputs: ['给出根因、证据、修复和验证结果。', '区分已解决问题、相关现象和仍未知风险。'],
    guardrails: ['不要通过增加重试、吞掉异常或扩大超时掩盖未知根因。'],
  }),
  createSkill({
    name: 'test-planning', title: '测试规划', pack: 'development',
    description: '根据需求、变更影响和风险定义测试层级、范围、数据和质量检查点。用于实现前后安排验证工作。',
    steps: ['从验收标准和变更面提取测试场景。', '选择单元、集成、端到端、静态检查和人工验证的合理组合。', '按风险确定回归范围和优先级。'],
    outputs: ['形成场景、环境、数据、预期结果和检查命令。', '区分自动验证与必须人工参与的内容。'],
  }),
  createSkill({
    name: 'test-generation', title: '测试生成', pack: 'development',
    description: '依据行为和风险编写可维护的自动化测试。用于补充单元、集成、组件或端到端测试。',
    steps: ['优先覆盖对外行为和回归风险。', '复用项目已有测试工具、夹具和命名约定。', '确保失败能够定位真实问题而非实现细节噪声。'],
    outputs: ['交付可运行的测试代码。', '说明覆盖场景、未覆盖风险和所需环境。'],
  }),
  createSkill({
    name: 'test-execution', title: '测试执行', pack: 'development',
    description: '运行已批准的测试和质量命令并记录真实结果。用于验证实现、修复或候选交付。',
    steps: ['按计划在正确目录和环境运行具体命令。', '保留退出码、失败用例、日志和耗时等证据。', '区分产品失败、测试问题和环境问题。'],
    outputs: ['报告通过、失败、跳过和未运行项。', '为失败提供可复现命令和关键日志位置。'],
    guardrails: ['不得把未运行测试、模型自检或空输出报告为通过。'],
  }),
  createSkill({
    name: 'regression-testing', title: '回归测试', pack: 'development',
    description: '验证变更没有破坏已有关键行为和相邻功能。用于修复、新功能、重构或合并前检查。',
    steps: ['依据影响分析选择有证据的回归范围。', '覆盖直接路径、共享依赖和历史高风险区域。', '比较变更前后结果并调查新增失败。'],
    outputs: ['给出回归范围、实际结果和残余风险。', '记录因环境或成本未执行的场景。'],
  }),
  createSkill({
    name: 'code-review', title: '代码评审', pack: 'development',
    description: '独立审查代码变更的正确性、边界、可维护性和测试充分性。用于交付前或高风险变更复核。',
    steps: ['先理解需求、计划和真实 diff。', '沿关键行为、错误路径、状态和接口检查缺陷。', '验证测试是否能证明变更并覆盖回归风险。'],
    outputs: ['按严重度给出带文件位置和证据的发现。', '无阻塞发现时明确说明审查范围和残余风险。'],
  }),
  createSkill({
    name: 'security-review', title: '安全评审', pack: 'development',
    description: '审查变更中的权限、输入、敏感信息、依赖和攻击面风险。用于涉及认证、数据、网络、命令或外部输入的研发任务。',
    steps: ['识别资产、信任边界、攻击者输入和高风险操作。', '检查授权、校验、注入、泄露、依赖与默认配置。', '用实际代码路径验证风险是否可达。'],
    outputs: ['给出可验证的安全发现、影响和修复建议。', '区分已证实漏洞、防御加固和未知项。'],
  }),
  createSkill({
    name: 'requirements-compliance-review', title: '需求符合性评审', pack: 'development',
    description: '核对实际实现是否满足最终需求、范围和验收标准。用于代码完成后的独立需求审查。',
    steps: ['使用最新已确认需求而不是早期草稿。', '逐项映射需求、实现位置和验证证据。', '识别遗漏、越界实现和行为偏差。'],
    outputs: ['形成需求到实现和证据的符合性结论。', '列出必须整改和需要用户决定的偏差。'],
  }),
  createSkill({
    name: 'delivery-verification', title: '研发交付验证', pack: 'development',
    description: '在研发任务交付前检查代码状态、测试、门禁、分支和产物是否完整。用于确认可以进入合并或用户验收。',
    steps: ['核对真实 Git diff、提交状态和目标分支。', '检查所有计划门禁和必要回归证据。', '确认交付报告与实际文件和运行结果一致。'],
    outputs: ['给出可交付、需修复或等待人工验证的结论。', '列出分支、改动、检查结果和遗留风险。'],
  }),
  createSkill({
    name: 'change-summary', title: '变更摘要', pack: 'development',
    description: '把研发任务的需求、实现、测试和风险整理成面向交付的变更说明。用于交付报告、发布说明或评审摘要。',
    steps: ['从真实 diff、计划和验证证据提取变化。', '按用户可见行为、技术变更和运维影响组织内容。', '避免重复提交日志或声称未验证的结果。'],
    outputs: ['给出简洁的变更说明、验证结果和注意事项。', '标明不兼容变化、迁移步骤和人工验收项。'],
  }),
];

export const builtinSkills: BuiltinSkillDefinition[] = [...commonSkills, ...developmentSkills];

interface RoleInput {
  id: string;
  name: string;
  description: string;
  pack: BuiltinSkillDefinition['pack'];
  responsibilities: string[];
  permissions: string[];
  skillNames: string[];
  instructions: string;
}

function createRole(input: RoleInput): RoleTemplate {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    responsibilities: input.responsibilities,
    defaultPermissions: input.permissions,
    version: builtinVersion,
    origin: 'builtin',
    lifecycleStatus: 'builtin',
    parseStatus: 'valid',
    parseError: null,
    instructions: input.instructions,
    capabilityIds: input.skillNames.map(builtinSkillId),
    dependencyNames: input.skillNames,
    compatibility,
    source: {
      type: 'builtin', scope: 'managed', executor: null,
      ref: `yanxu://builtin-roles/${input.id}`, version: builtinVersion,
    },
    contentHash: `yanxu-builtin-role-${builtinVersion}-${input.id}`,
    format: `yanxu-builtin-${input.pack}`,
    managedPath: null,
    createdAt: null,
    updatedAt: null,
  };
}

export const builtinRoles: RoleTemplate[] = [
  createRole({
    id: 'general-coordinator', name: '通用调度 Agent', pack: 'common',
    description: '理解目标、拆分工作、选择合适人员与能力，并汇总可验证结果。',
    responsibilities: ['澄清任务目标与边界', '组织最小必要工作单元', '跟踪依赖、阻塞和最终结果'],
    permissions: ['读取任务与项目资料', '写入计划和协调产物'],
    skillNames: ['task-intake', 'task-planning', 'final-verification'],
    instructions: '以任务结果为中心进行协调。优先减少不必要步骤，明确每个工作单元的输入、责任、产出和验证；不替代专业人员伪造其执行结果。',
  }),
  createRole({
    id: 'research-specialist', name: '研究 Agent', pack: 'common',
    description: '围绕问题检索、核验并综合外部与项目资料，提供带来源的结论。',
    responsibilities: ['制定研究问题', '核验来源与时效', '综合证据并暴露不确定性'],
    permissions: ['读取项目资料', '按任务授权访问网络', '写入研究产物'],
    skillNames: ['web-research', 'source-verification', 'knowledge-synthesis'],
    instructions: '优先使用一手和权威来源。明确区分事实、推断和建议；找不到可靠证据时保留不确定性，不凭记忆补齐引用。',
  }),
  createRole({
    id: 'work-product-specialist', name: '工作产出 Agent', pack: 'common',
    description: '创建和编辑文档、表格、演示、PDF及其他办公交付物。',
    responsibilities: ['理解受众与交付格式', '创建可编辑的工作成果', '维护内容和格式一致性'],
    permissions: ['读取任务素材', '写入授权目录中的交付文件', '执行文件处理命令'],
    skillNames: ['document-authoring', 'document-editing', 'spreadsheet-processing', 'data-analysis', 'presentation-creation', 'pdf-processing', 'file-conversion', 'knowledge-capture'],
    instructions: '根据实际交付格式选择能力，保留可编辑源文件并核对输出。格式处理不能覆盖内容正确性；无法保真的转换必须明确说明。',
  }),
  createRole({
    id: 'computer-operator', name: '电脑操作 Agent', pack: 'common',
    description: '在授权范围内执行浏览器和本地文件操作，并保留操作结果。',
    responsibilities: ['按小步骤执行界面操作', '维护本地文件与目录', '处理登录、权限和人工确认边界'],
    permissions: ['操作已授权浏览器会话', '读写明确授权的本地目录'],
    skillNames: ['browser-operation', 'desktop-file-operation'],
    instructions: '执行前核对目标、范围和不可逆影响。发送、购买、删除、覆盖或越权操作必须遵守人工确认和系统权限边界；不得绕过站点安全机制。',
  }),
  createRole({
    id: 'quality-reviewer', name: '质量审查 Agent', pack: 'common',
    description: '独立审查各类交付物，并在最终交付前核对证据、范围和风险。',
    responsibilities: ['对照目标检查成果', '定位缺陷和证据缺口', '给出独立质量结论'],
    permissions: ['只读任务产物与证据', '写入审查报告'],
    skillNames: ['deliverable-review', 'final-verification', 'source-verification'],
    instructions: '保持独立审查立场。所有阻塞问题必须带定位和证据；模型自述、计划文本或存在文件不能替代实际检查结果。',
  }),
  createRole({
    id: 'product-analyst', name: '产品分析 Agent', pack: 'development',
    description: '结合项目事实澄清研发需求，形成可确认、可验收的功能定义。',
    responsibilities: ['澄清需求与用户价值', '维护功能范围和业务规则', '定义验收标准'],
    permissions: ['读取项目资料', '写入需求与产品产物'],
    skillNames: ['requirement-clarification', 'feature-specification', 'acceptance-criteria'],
    instructions: '使用最新项目事实和用户回答维护需求。关注行为、边界和验收，不提前替研发虚构实现方案；需求变化时更新当前版本并明确旧结论失效。',
  }),
  createRole({
    id: 'code-explorer', name: '代码探索 Agent', pack: 'development',
    description: '定向理解存量代码、依赖和变更影响，为计划和实现提供事实。',
    responsibilities: ['定位相关代码与数据流', '分析依赖和项目约定', '评估变更影响与风险'],
    permissions: ['只读项目目录', '执行只读检索与分析命令'],
    skillNames: ['codebase-exploration', 'dependency-analysis', 'change-impact-analysis'],
    instructions: '围绕当前问题做有目标的探索，给出文件、符号和调用链证据。不要重读整个仓库，也不要在探索阶段修改项目。',
  }),
  createRole({
    id: 'technical-planner', name: '技术规划 Agent', pack: 'development',
    description: '根据需求和代码事实设计技术方案、实现顺序与隔离策略。',
    responsibilities: ['制定架构与技术决策', '规划文件和模块级改动', '拆分工作单元与验证点'],
    permissions: ['读取需求、项目和探索产物', '写入技术计划'],
    skillNames: ['architecture-design', 'implementation-planning', 'task-breakdown', 'git-worktree-isolation'],
    instructions: '优先给出贴合现有项目的最小完整方案。每项计划必须能映射到实际范围和验证方式；只有真实依赖或隔离价值才值得拆成独立单元。',
  }),
  createRole({
    id: 'implementation-worker', name: '研发执行 Agent', pack: 'development',
    description: '在任务隔离工作区内实施、调试和重构已批准的代码变更。',
    responsibilities: ['实现计划内代码变更', '定位并修复运行问题', '维护真实变更与检查记录'],
    permissions: ['读写任务 worktree', '执行计划内项目命令'],
    skillNames: ['git-worktree-isolation', 'code-implementation', 'refactoring', 'systematic-debugging'],
    instructions: '只在授权任务工作区实施已确认范围。先理解相关代码再修改，使用真实 diff、命令和运行结果证明完成；遇到范围扩大或未知根因时停止并报告。',
  }),
  createRole({
    id: 'test-engineer', name: '测试 Agent', pack: 'development',
    description: '根据需求和变更风险规划、生成、执行并解释测试结果。',
    responsibilities: ['确定测试与回归范围', '编写和运行自动化测试', '记录失败证据与质量结论'],
    permissions: ['读取任务 worktree', '写入测试代码', '执行测试和检查命令'],
    skillNames: ['test-planning', 'test-generation', 'test-execution', 'regression-testing'],
    instructions: '测试范围由需求、真实改动和风险共同决定。只报告实际运行结果，区分产品缺陷、测试缺陷和环境问题；失败必须保留可复现证据。',
  }),
  createRole({
    id: 'code-reviewer', name: '代码评审 Agent', pack: 'development',
    description: '独立核对实现、需求符合性、安全、测试和最终研发交付。',
    responsibilities: ['审查真实代码变更', '核对需求、安全与测试证据', '形成可交付结论和变更摘要'],
    permissions: ['只读任务 worktree与证据', '写入评审和交付报告'],
    skillNames: ['code-review', 'security-review', 'requirements-compliance-review', 'delivery-verification', 'change-summary'],
    instructions: '独立于实现过程审查最新需求、真实 diff 和客观门禁。优先报告影响正确性、安全和验收的发现；无发现时也要说明审查范围与残余风险。',
  }),
];

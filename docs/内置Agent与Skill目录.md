# 内置 Agent 与 Skill 目录

更新日期：2026-08-10  
目录版本：2.0.0

## 1. 定位

Yanxu 的内置 Agent 实际是 `RoleTemplate`。用户选择 Role、可用 CLI、模型和权限模式后，才创建一个可加入团队的 AI 人员。

Skill 是独立的可装载 Capability。内置 Role 只声明默认推荐 Skill：

- 不把 Skill 变成固定流程节点；
- 不要求团队覆盖全部 Role 或 Skill；
- 规划器根据任务目标、人员、项目已启用能力和 CLI 兼容性选择实际装载项；
- 任务确认后仍按 WorkUnit 冻结 Skill 版本和内容哈希；
- 项目没有启用某个 Skill 时，Role 的默认推荐不能绕过项目能力边界。

## 2. 通用 Agent

| Agent Role | 主要责任 | 默认 Skill |
| --- | --- | --- |
| 通用调度 Agent | 澄清目标、组织最小必要工作单元、跟踪依赖和结果 | `task-intake`、`task-planning`、`final-verification` |
| 研究 Agent | 检索、核验和综合外部与项目资料 | `web-research`、`source-verification`、`knowledge-synthesis` |
| 工作产出 Agent | 创建和编辑文档、表格、演示、PDF及其他办公成果 | `document-authoring`、`document-editing`、`spreadsheet-processing`、`data-analysis`、`presentation-creation`、`pdf-processing`、`file-conversion`、`knowledge-capture` |
| 电脑操作 Agent | 执行授权的浏览器和本地文件操作 | `browser-operation`、`desktop-file-operation` |
| 质量审查 Agent | 独立审查交付物并核对最终证据 | `deliverable-review`、`final-verification`、`source-verification` |

通用 Skill 共 17 个：

`task-intake`、`task-planning`、`web-research`、`source-verification`、`knowledge-synthesis`、`document-authoring`、`document-editing`、`spreadsheet-processing`、`data-analysis`、`presentation-creation`、`pdf-processing`、`file-conversion`、`knowledge-capture`、`browser-operation`、`desktop-file-operation`、`deliverable-review`、`final-verification`。

## 3. 研发增强 Agent

| Agent Role | 主要责任 | 默认 Skill |
| --- | --- | --- |
| 产品分析 Agent | 澄清研发需求、定义功能行为和验收标准 | `requirement-clarification`、`feature-specification`、`acceptance-criteria` |
| 代码探索 Agent | 定向理解代码、依赖和变更影响 | `codebase-exploration`、`dependency-analysis`、`change-impact-analysis` |
| 技术规划 Agent | 设计技术方案、实现顺序、工作单元和隔离策略 | `architecture-design`、`implementation-planning`、`task-breakdown`、`git-worktree-isolation` |
| 研发执行 Agent | 在隔离工作区实施、调试和重构代码 | `git-worktree-isolation`、`code-implementation`、`refactoring`、`systematic-debugging` |
| 测试 Agent | 规划、生成、执行测试并确定回归范围 | `test-planning`、`test-generation`、`test-execution`、`regression-testing` |
| 代码评审 Agent | 独立核对代码、需求、安全、测试和研发交付 | `code-review`、`security-review`、`requirements-compliance-review`、`delivery-verification`、`change-summary` |

研发增强 Skill 共 22 个：

`requirement-clarification`、`feature-specification`、`acceptance-criteria`、`codebase-exploration`、`dependency-analysis`、`change-impact-analysis`、`architecture-design`、`implementation-planning`、`task-breakdown`、`git-worktree-isolation`、`code-implementation`、`refactoring`、`systematic-debugging`、`test-planning`、`test-generation`、`test-execution`、`regression-testing`、`code-review`、`security-review`、`requirements-compliance-review`、`delivery-verification`、`change-summary`。

## 4. 安装和迁移行为

- 全新环境首次启动时，39 个内置 Skill 以 `installed` 状态写入 Capability Registry，并生成到 `~/.yanxu/capabilities/<capability-id>/<content-hash>/SKILL.md`。
- 内置 Skill 与外部 Skill 使用相同生命周期：都可安装、卸载和重新安装。用户卸载内置 Skill 后，后续重启不会把它强制恢复为已安装。
- 同类型、同名称的 Skill/MCP 在界面中只展示为一项逻辑能力，OpenCode、Claude、内置、本地、ZIP 和 GitHub 等记录作为可选择的来源版本。任一时刻只允许一个来源处于已安装状态；安装其他来源即执行来源切换。
- 卸载会同步停用项目中的该能力，并从 AI 人员默认能力中移除。Role 仍保留依赖名称用于说明，但会将未安装依赖标记为不可用，规划与真实执行均不会挂载它。
- 研序保留卸载能力的托管副本、内容哈希和来源元数据，以便审计或重新安装；“保留副本”不等于“仍可调用”。
- Skill 同时兼容 OpenCode 和 Claude Code；Codex 不在当前内置兼容范围内。
- 原来的 `产品`、`研发`、`测试`、`评审` 四个内置 Role 不再展示。
- 已存在的 AI 人员不会被删除：启动时分别迁移为 `产品分析 Agent`、`研发执行 Agent`、`测试 Agent`、`代码评审 Agent`。人员原来已有默认能力时保持原选择；为空时补充新 Role 的默认 Skill。
- 外部导入的 Role、Skill 和 MCP 不受本次内置目录替换影响。

## 5. 使用原则

内置目录解决的是“开箱即用的人员职责和工作方法”，不是重新引入固定研发流水线。例如：

- 文档整理任务可以只使用工作产出 Agent；
- 调研并形成报告可以组合研究 Agent、工作产出 Agent和质量审查 Agent；
- 小型代码修复可以只组合研发执行 Agent和代码评审 Agent；
- 复杂产品研发可以根据实际需要使用产品分析、代码探索、技术规划、研发执行、测试和代码评审 Agent；
- 即使 Role 默认推荐多个 Skill，计划也只应装载当前 WorkUnit 真正需要且项目已经启用的能力。
- 最终装载集合始终取“确认计划所选能力、项目当前启用能力、当前已安装能力、执行 CLI 兼容能力”的交集。卸载或兼容性变化发生后，以真实调用时的状态为准。

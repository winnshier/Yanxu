# 研序 Yanxu

研序是一个本地优先的 AI 研发编排工作台。用户提交需求并确认计划后，系统按项目事实自动组织需求分析、实现、测试、质量门禁、评审和交付；任务可以暂停、停止、恢复和自动重试，全程保留可追溯记录。

研序不是把多个 CLI 简单串成一条提示词。它负责持久化任务状态、调度独立会话、隔离 Git 工作区、执行确定性门禁，并把经过用户确认的项目认知沉淀到独立于代码仓库的 ProjectSpace。

## 当前版本

第一版面向 macOS，本地开箱即用，不需要登录：

- 支持一个项目关联多个本地目录，目录可以是代码、文档或空目录；没有 Git 的目录会在首个相关任务计划确认后初始化本地仓库。
- 内置产品、研发、测试、评审 Role 和需求分析、技术设计、实现、测试、交付评审等 Skill。
- 支持创建 AI 人员并自由组成团队；人员绑定 Role、CLI、模型和权限模式。
- OpenCode 是当前可执行适配器；Claude Code 和 Codex CLI 已纳入探测与扩展接口，但尚未开放任务执行。
- 不同任务可以并行；同一任务的 SkillStep 串行执行，每个步骤使用独立 Session。
- 提交分析后由协调器判断本任务是否需要需求规格 Skill；需要时先生成版本化 RequirementSpec，不需要时直接依据用户需求和项目事实规划。用户回答歧义并确认后，需求版本、确认前产物、计划、团队、人员和权限清单一起冻结为运行快照。
- 每个 Skill 都声明必须产出的 Artifact 类型、完成检查和是否允许阻断交付；执行结果不满足契约时不会被“口头完成”绕过，测试或评审可以把任务退回实现。
- 每个 SkillStep 必须生成可版本化 Artifact；下一步骤由 ContextPack 按冻结计划、上游 Artifact、相关项目知识和失败证据组装最小上下文，不需要重读全部历史。
- 创建任务时可选择本地附件；附件通过短期令牌复制到 ProjectSpace 并记录哈希，文本内容按上限进入需求/计划上下文，二进制附件只保留原始证据。
- 规划器会在容量上限内检索关联目录中的相关代码、配置和文档，同时排除常见密钥与敏感路径；歧义回答必须先由规划器吸收到新版计划，之后才能由用户最终确认。
- 通过 Git branch + worktree 隔离任务，已有 staged、unstaged、untracked 内容会冻结为任务基线，不改动用户原工作区和索引。
- 计划确认时会冻结来源工作树指纹；执行前发现用户又修改了来源目录时会停止使用旧计划并要求重新规划，避免在过期事实之上执行。
- 每个成功 SkillStep 都记录逐文件 ChangeManifest；越界或敏感文件改动只记录拒绝事件与文件路径，不会进入 checkpoint，并转为需要重新确认的计划。
- 用户确认的文件范围、只读边界和命令会按步骤编译为可审计 PermissionManifest；标准模式把计划外动作送到调度台，全托管模式自动拒绝未规划动作，两种模式都不能突破敏感文件与高风险操作硬边界。
- 后台任务支持租约恢复、指数退避重试和一次边界内自动重规划；扩大目录、权限、目标或成功标准时必须重新人工确认。
- 质量门禁以 argv 直接执行，记录每轮命令、退出码、信号、超时和日志；测试设计 Skill 可以补充范围更窄的任务专项门禁，但不能扩大计划确认的命令边界。
- 交付时可以保留任务分支自行合并，或由研序预检后合并到任务指定的目标分支；机械性冲突可确定处理，语义冲突会保留现场等待用户，多目录中途失败会反向补偿，合并后还会在临时 worktree 重跑门禁。
- 交付后生成项目知识候选。候选可修订、确认或驳回，修订和确认都会创建新版本并保留 supersedes 链，只有当前有效版本进入全文检索上下文。
- Project Directory Profile 先生成候选版本，由用户确认后才替换当前事实；ProjectSpace 的文档写入与 Git milestone 有独立操作日志，失败不会被静默忽略。
- 每次 ProjectSpace milestone 都会刷新带哈希的 `state/current.json`；SQLite 丢失时可在项目页选择 ProjectSpace 预演并恢复项目、目录、团队引用、任务、计划、附件、Session、权限、变更、门禁、冲突、交付、事件、知识和运行快照。无法恢复的运行现场会安全转为 `STOPPED`。
- 交付结果被用户纠正时会生成新的 TaskVersion；旧需求、计划和证据保留，源自旧版本的候选/有效知识会退出检索，避免继续传播错误经验。
- 用户项目不绑定语言或框架；质量门禁会优先识别已有 Node.js、Python、Go、Rust 或 Makefile 检查命令。

## 运行要求

- macOS
- Node.js 22.13.0 或更高版本
- pnpm（项目不限制 pnpm 主版本；所用版本需要能够读取当前锁文件）
- Git
- OpenCode CLI（浏览和配置工作台不要求；创建 OpenCode 人员、分析或执行任务时才校验）

在 Node.js 22 和 24 之间切换后，`./yanxu` 会自动检测并按当前 Node.js ABI 重编译 `better-sqlite3`。

## 一键启动

```bash
git clone <your-fork-or-repository-url>
cd Yanxu
./yanxu
```

脚本会在首次运行时安装锁定依赖，构建前后端，启动本地服务并打开 `http://127.0.0.1:43120`。按 `Ctrl+C` 停止服务。

开发模式：

```bash
./yanxu dev
```

如果文件执行权限在下载过程中丢失，可先运行 `chmod +x yanxu`。

## 首次使用

1. 打开“设置”，检测本地 CLI，执行一次真实 Runtime 启停验证，并选择全局协调模型。
2. 在“AI 团队”中创建人员。第一版请选择 OpenCode、Role 和该 CLI 可用的模型。
3. 将人员组成一个团队；可以设置一个全局默认团队。
4. 创建项目并选择首个本地目录。ProjectSpace 由研序自动分配，不会放进代码目录。
5. 创建任务，选择项目和团队，提交需求分析。
6. 回答歧义问题，检查动态 Skill 步骤、执行人员、涉及目录、质量门禁及源/目标分支；保存计划并确认后，系统准备隔离工作区并无人值守推进。
7. 在调度台处理权限、阻塞或交付确认；交付知识需要在项目页单独确认后才会参与后续检索。

## 本地数据

默认数据目录为 `~/.yanxu`：

```text
~/.yanxu/
├── system/app.db             # SQLite 状态、任务、事件、权限和索引
├── projects/<project-id>/    # 每个项目独立的 ProjectSpace 与 Git 历史
├── runtime/tasks/<task-id>/  # task worktree、执行现场、操作日志
└── runtime/logs/             # 本地运行日志
```

ProjectSpace 与用户关联的项目目录是两个概念：前者保存需求、计划、步骤产物、交付报告和知识版本；后者保存实际代码或文档。两边分别使用 Git 追踪。

Daemon 使用单实例锁避免两个本地进程同时调度同一数据库；健康接口会分别报告数据库和 Scheduler 状态。工作台 API 使用本机持久随机会话 Cookie 与 CSRF 令牌，写请求会拒绝跨站来源；文件夹和附件选择使用短期一次性 token，网页不能直接提交任意绝对路径。

临时改变数据目录或端口：

```bash
YANXU_HOME=/path/to/local-data YANXU_PORT=44000 ./yanxu
```

## 安全边界

- 执行器默认只允许在研序准备的隔离工作区内工作。
- 工作台 API 需要 HttpOnly、SameSite=Strict 的本机会话 Cookie；所有修改请求还需要 CSRF 令牌。
- 系统文件夹与附件选择只返回短期一次性 token，真实路径只在本地 Daemon 内解析。
- `.env`、私钥等敏感文件不会进入任务基线，运行规则也拒绝读取常见密钥文件。
- 默认禁止 `git push`、修改远程仓库、部署、`sudo` 和高风险递归删除。
- 标准权限模式把未预授权动作送到调度台；全托管模式仍保留上述不可突破的硬边界。
- “合并到目标分支”只操作本地 Git，不会推送远程。冲突时保留任务分支并要求用户决定。

## 开发与校验

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

工作区结构：

```text
apps/web          React + TypeScript + Ant Design 6
apps/daemon       Fastify 本地服务与调度器
packages/contracts 共享模型与 API Schema
packages/core     SQLite、ProjectSpace、状态机和 Git 隔离
packages/executors CLI 探测与 OpenCode SDK 适配
packages/builtins 内置 Role 与 Skill
migrations        SQLite 迁移
```

## License

[MIT](./LICENSE)

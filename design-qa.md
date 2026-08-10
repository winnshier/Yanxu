# Yanxu 页面级布局改版验收

## 验收结论

本轮已按“纯左右布局 + 具体模块页面重排”完成第二轮改版。应用壳层不再显示“本地工作区 / ProjectSpace”说明块，也不再显示右侧顶部标签栏；右侧从页面标题开始直接进入连续工作区。项目、任务、团队/角色、能力中心、定时任务和设置均已分别改造，不再只是更换外壳或配色。

## 验收范围

- 应用壳层：固定左侧导航、连续右侧工作区
- 调度台：横向运行摘要与扁平工作区模块
- 项目：高密度项目目录
- 任务：执行目录、步骤链、状态与操作列
- 项目/任务详情：主内容与属性侧栏
- AI 团队：人员目录、团队目录与角色库
- 能力中心：Skill/MCP 能力目录与兼容状态
- 定时任务：触发器目录与左右分栏编辑器
- 设置：CLI 运行环境表格、能力矩阵与协调配置
- 创建任务：需求输入与执行约束左右分栏编辑器

## 视觉真值与实现证据

参考图：

- `docs/assets/multica-ui-reference/03-project-detail.png`
- `docs/assets/multica-ui-reference/04-new-issue-agent.png`
- `docs/assets/multica-ui-reference/05-agent-working.png`
- `docs/assets/multica-ui-reference/06-task-transcript.png`
- `docs/assets/multica-ui-reference/07-run-result.png`
- `docs/assets/multica-ui-reference/08-skills-list.png`
- `docs/assets/multica-ui-reference/09-runtime-detail.png`
- `docs/assets/multica-ui-reference/10-autopilot-schedule.png`

实现截图：

- `docs/assets/design-qa-v2/dashboard-1600.png`
- `docs/assets/design-qa-v2/projects-1600.png`
- `docs/assets/design-qa-v2/tasks-1600.png`
- `docs/assets/design-qa-v2/project-detail-1600.png`
- `docs/assets/design-qa-v2/task-detail-1600.png`
- `docs/assets/design-qa-v2/team-agents-1600.png`
- `docs/assets/design-qa-v2/role-library-1600.png`
- `docs/assets/design-qa-v2/capabilities-1600.png`
- `docs/assets/design-qa-v2/settings-1600.png`
- `docs/assets/design-qa-v2/create-task-1600.png`
- `docs/assets/design-qa-v2/schedule-editor-1600.png`

同屏对照证据：

- `docs/assets/design-qa-v2/compare-project-detail.png`
- `docs/assets/design-qa-v2/compare-task-detail.png`
- `docs/assets/design-qa-v2/compare-capabilities.png`
- `docs/assets/design-qa-v2/compare-settings.png`
- `docs/assets/design-qa-v2/compare-create-task.png`
- `docs/assets/design-qa-v2/compare-schedule-editor.png`

浏览器视口为 `1600 × 1000 CSS px`，设备像素比为 `1`，实现截图为 `1600 × 1000 px`。对照图将参考图与实现图等宽归一后并排，用于检查整页布局、信息密度和模块关系。

## 对照过程与修正记录

本轮初始发现：

- P1：侧栏仍显示“本地工作区 / ProjectSpace”说明块，占用无效空间。
- P1：右侧仍有标签式顶栏，使布局变成“侧栏 + 顶栏 + 页面容器”三层结构。
- P1：项目、任务、人员、团队与定时任务主要由大卡片堆叠，未形成参考图中的目录式工作区。
- P1：调度台模块边界过重，右侧工作区仍像嵌套窗口。
- P2：角色导入区在首轮重排后出现控件纵向堆叠。

完成的修正：

- 删除侧栏本地工作区说明块与右侧标签顶栏，落实纯左右结构。
- 去除右侧外层卡片和大圆角容器，页面直接使用连续白色工作区。
- 调度台改为横向摘要条与扁平模块区。
- 项目、任务、人员、团队、能力与定时任务改为稳定列对齐的目录/表格结构。
- 任务行增加进度、当前步骤链、运行信息、状态和操作的单行扫描关系。
- 项目/任务详情继续使用主内容与固定属性侧栏，并统一页面头部和标签高度。
- 创建任务、创建定时任务保留左右分栏编辑器，缩短扫描距离。
- 设置页统一为运行环境表格、能力矩阵和配置区，不再用独立大卡片分割每一项。
- 修复角色导入控件堆叠问题；保留窄屏下的单列回退。

复核结果：

- Typography：标题、正文、辅助文字和表头层级统一，长文本保留省略与换行边界。
- Spacing / layout：左侧导航宽度稳定，右侧无额外顶栏；目录行、工具栏、表头和属性栏对齐。
- Colors / tokens：保留 Yanxu 的品牌蓝与状态色，采用低层级灰色分隔，不复制 Multica 的深色主题。
- Images / icons：继续使用产品已有图标系统；本轮参考重点是信息架构与排版，不引入装饰性图片。
- Copy：未为追求截图相似而替换 Yanxu 的 ProjectSpace、CLI、任务阶段、角色与技能等产品语义。
- 项目概览和任务执行目录使用 Yanxu 自身的任务阶段与进度表达；没有逐字复制 Multica 看板，属于产品语义上的有意适配。
- 复核后未发现剩余 P0、P1、P2 视觉问题、遮挡或关键操作缺失。

## 交互与技术验证

已验证：

- 左侧导航在调度台、项目、任务、定时任务、AI 团队、能力中心和设置间切换
- 任务归档筛选与真实任务目录展示
- 项目详情、任务详情标签及属性侧栏展示
- AI 人员、团队、角色库标签切换
- 创建任务弹窗打开及左右分栏展示
- 创建定时任务弹窗打开及左右分栏展示
- 能力中心筛选工具栏与能力目录展示
- 页面在 `1600 × 1000` 视口下无横向溢出、遮挡和顶栏残留
- 最终浏览器控制台错误：0
- `pnpm check`：通过
  - TypeScript 类型检查通过
  - ESLint 通过
  - 128 个自动化测试通过，3 个显式跳过的 live 测试不计失败
  - Web 与 daemon 生产构建通过
- 最后一处 Ant Design `Tag` 兼容性调整后再次复核 Web：14 个测试、类型检查和生产构建均通过，测试输出无弃用警告

证据边界：Yanxu 特有的任务执行目录、团队组合和角色库没有一一对应的 Multica 参考页，因此采用同一套高密度目录、低层级分隔和单行操作语言进行产品化适配，而不是制造不存在的截图对应关系。

final result: passed

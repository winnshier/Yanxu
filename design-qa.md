# 能力中心视觉验收

- Source visual truth: `/var/folders/d8/p0rzmdb17lx5q04x9q7pqmv80000gn/T/codex-clipboard-d636fb90-faff-41d4-887c-5ba2f9469efc.png`
- Implementation screenshot: `/private/tmp/yanxu-capability-center-reference-size.jpg`
- Route: `http://127.0.0.1:43120/capabilities`
- State: 已重新扫描本机能力、全部分类、页面顶部、无弹窗
- Viewport: 2000 × 1300 CSS px
- Source pixels: 2000 × 1300
- Implementation pixels: 2000 × 1300
- Device pixel ratio: 2；浏览器截图已归一化为 CSS 像素尺寸，无需额外缩放

## Full-view comparison evidence

参考图的核心结构是“标题操作区 → 汇总分布条 → 单行能力列表”。Yanxu 实现保留现有左侧应用导航，并在主内容区采用相同的信息层级：顶部显示能力总量、Skill/MCP、安装状态和 CLI 分布，下方使用统一行高的管理列表。两张图在相同 2000 × 1300 视口下完成并排核对。

## Focused region comparison evidence

- 汇总区：总量在左，分类与 CLI 彩色胶囊在右；颜色克制、数字权重明确，和参考图的信息读取顺序一致。
- 列表区：名称、种类、说明、来源、兼容 CLI、运行状态和操作均保持稳定列位；长路径收敛为次级单行文本。
- 凭据状态：本机 CLI 凭据使用绿色轻量标签，外部不安全凭据和无效配置继续使用警示状态。
- 操作区：导入入口收进菜单，扫描保持主按钮；详情与安装维持在每行最右侧。

## Required fidelity surfaces

- Fonts and typography: 沿用产品现有 Inter、PingFang SC 和系统字体；标题、计数、正文、路径形成四级层次，未出现异常换行或截断。
- Spacing and layout rhythm: 汇总与列表采用 18px 圆角和细边框，列表行约 95px；主信息、状态和操作对齐稳定。
- Colors and visual tokens: 继续使用 Yanxu 主蓝色，同时用浅橙、浅绿、浅紫区分 Skill、MCP、OpenCode 和 Claude，语义与参考图一致。
- Image quality and asset fidelity: 页面没有需要复刻的内容图片；界面图标全部来自现有 Ant Design 图标库，没有使用占位图或自制图形。
- Copy and content: 保留 Yanxu 的能力生命周期、安全边界、项目启用和版本冻结语义，没有照搬参考产品文案。

## Findings

没有遗留的 P0、P1 或 P2 视觉问题。左侧应用导航、仅展示 OpenCode/Claude 两类执行器，以及安全状态列属于 Yanxu 的产品约束，不作为设计偏差。

## Interaction and responsive checks

- 本机能力扫描成功，明文凭据旧状态在重扫后更新为“本机凭据”。
- 导入能力菜单可打开，包含本地 Skill、ZIP 和 GitHub 三种入口。
- 能力详情安全审查弹窗可正常打开和关闭。
- 900 × 800 视口下列表改为分行布局，文档宽度等于视口宽度，无横向溢出。
- 浏览器控制台未发现页面错误。

## Comparison history

- Pass 1: 在默认 1280 × 720 视口确认顶部统计、前三行能力和操作区均正确渲染。
- Pass 2: 在 900 × 800 视口确认响应式折行与无横向溢出。
- Pass 3: 在与参考图一致的 2000 × 1300 视口完成最终同尺寸比较；无新增 P0/P1/P2 问题。

## Follow-up polish

无阻塞项。后续若增加 Codex 等执行器，可直接沿用现有 CLI 胶囊和汇总计数模式。

final result: passed

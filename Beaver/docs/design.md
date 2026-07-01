# Beaver Desktop — 设计规范 (B6)

桌面端(Electron renderer)的主题、控件来源、窗口架构与面板布局约定。此文档是 B6 的锚:先定契约,再搭 renderer。代码/token/组件名/路径一律英文,说明性文字中文。

## 1. 技术栈

与参考实现(Multica desktop)对齐,避免 base-ui API 漂移:

| 层 | 选型 | 版本 |
|---|---|---|
| 壳 | electron-vite + @electron-toolkit | 现有 root `electron.vite.config.ts` 基线 |
| UI 框架 | React | 19.2 |
| 样式 | Tailwind CSS v4 (`@tailwindcss/vite`) + `tw-animate-css` | ^4 |
| 无头控件 | `@base-ui/react` | 1.3.0(pin,勿升) |
| 变体 | `class-variance-authority` 0.7.1 · `clsx` 2.1.1 · `tailwind-merge` ^3 |
| 面板 | `react-resizable-panels` 4.7.5 |
| 图标 | `lucide-react` |
| i18n | `i18next` + `react-i18next` |

主进程 = Node(D10 便携性:core/client 不依赖 Node/Bun 全局);renderer = React。

## 2. 品牌与主题

- 产品名 **Beaver**,自有品牌,不搬 Multica 的 LOGO/版权信息(许可证条款 b 只约束分发它的前端,我们不触发)。
- 强调色(brand):暖琥珀/棕(beaver 意象),`oklch` 表达;light + dark 双主题,`next-themes` 或等价切换。
- Token 沿用 shadcn/base-ui 语义变量:`--background/--foreground/--card/--primary/--secondary/--muted/--accent/--destructive/--border/--input/--ring/--sidebar-*/--brand`,半径 `--radius` 派生 `--radius-{sm..4xl}`。
- 单一 token 源:`packages/ui/styles/tokens.css`(改自 Multica `tokens.css`),Web/Desktop 复用。改品牌只改 `--brand` 与 `--primary`。

## 3. 控件来源与署名

- 控件改编自 Multica `@multica/ui`(Apache-2.0 派生许可),其血统是 shadcn/ui + `@base-ui/react`。
- **义务**:仓库放 `packages/ui/NOTICE` 注明 "portions adapted from Multica (Apache-2.0)";保留其许可。不移除其品牌即不触发条款 b;内部使用不触发条款 a(对外售卖/SaaS 才需商业授权)。
- 落点 `packages/ui`(`@beaver/ui`):`components/ui/*`、`lib/utils.ts`(`cn`)、`hooks/*`、`styles/*`。import 改写 `@multica/ui` → `@beaver/ui`,`@base-ui/react` 保留。
- 首批(只依赖 base-ui + cva + cn + lucide + resizable 的干净集):button, card, badge, separator, scroll-area, resizable, tabs, tooltip, input, textarea, label, skeleton, spinner, avatar, dropdown-menu, dialog, sheet, switch, checkbox, toggle, kbd, empty, item, alert, progress。重依赖控件(chart/calendar/carousel/command/drawer/sonner/data-table/markdown)按屏幕需要再引。

## 4. 包结构

```
packages/ui       @beaver/ui     — 设计系统(tokens + 控件),Web/Desktop 共享
packages/desktop  @beaver/desktop — Electron 主/预加载/renderer
```

## 5. 窗口架构

多窗口 Electron:

- **Main window** — 任务/运行的三栏工作台(见 §6)。
- **Preferences window** — 独立窗口,macOS `⌘,` 打开,标题 **Preferences**(不叫 Config/Settings)。
  - 独立的 renderer entry(electron-vite 多入口),不塞进主界面 —— 否则主界面展示不优雅。
  - 编辑 `BeaverConfig`(agentProfiles + provider、workspaceRoot、verifier、maxConcurrentRuns、taskSource…)。
  - 走 IPC → 主进程 → daemon 的 `config get/set`(CLI-first:每个能力 CLI 可达,Preferences 只是同一 daemon 能力的 GUI slot)。
  - 表单 slot 由此集中:新增配置项时,daemon schema + CLI `config` + Preferences 表单三处对齐。

## 6. 面板布局(Main window)

`react-resizable-panels` 三栏,改自 Multica `desktop-layout.tsx`:

```
┌──────────┬───────────────┬───────────────────┐
│ Sidebar  │ Task / Run     │ Detail            │
│ (nav +   │ list           │ (run stream:      │
│  repos)  │ (可选/可运行)   │  agent.text /     │
│          │                │  tool_use / diff) │
└──────────┴───────────────┴───────────────────┘
```

- 右栏消费 SSE 事件流(D19 resumable cursor),渲染 `agent.text/thinking/tool_use/tool_result` 与 handoff diff。
- 面板宽度持久化到本地(非 SSOT,纯 UI 偏好)。

## 7. i18n

- 双语 en-US / zh-CN(`react-i18next`)。
- daemon 只返回 error code + params(稳定英文),客户端本地化文案 —— renderer 不硬编码中文错误串。

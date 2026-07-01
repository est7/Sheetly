# Beaver ROADMAP（B0–B9 收官文档）

Beaver 是 Workcell 原型的生产化重写:一个 **CLI-first 的 C/S 自主编码 runner**。daemon 是 server(SSOT + 编排),CLI 与 Electron 是 client;daemon 的每个能力都 CLI 可达(`--json`、稳定退出码 0/1/2/3)。此文档记录 B0–B9 各阶段交付、关键架构决策、安全不变量、审计记录——之前 roadmap 只在对话里,这里落盘。代码/标识符英文,说明中文。

## 架构

```
task source (localJson / larkBase / …)      agent provider (claude-code / pi / codex / generic)
        │  ExternalTask                              │  AgentBackend → normalized AgentMessage
        ▼                                            ▼
   ┌─────────────────────── daemon (bun, server) ───────────────────────┐
   │ SQLite SSOT · RunOrchestrator(state machine)· EventLog(append-only)│
   │ UDS(~/.beaver/daemon.sock, 0600)· SSE /events(resumable cursor)   │
   └──────────────┬───────────────────────────────┬────────────────────┘
        CLI client │                                │ Electron main (BeaverClient)
                   ▼                                ▼
              apps/cli                       @beaver/desktop（Main 三栏 + Preferences 窗）
```

单向依赖:`@beaver/core`(契约,便携)← `@beaver/client` / `@beaver/daemon` / `apps/cli`;`@beaver/ui` ← `@beaver/desktop`。core/client 不依赖 Node/Bun 全局(D10 便携性)。

## 阶段

| 阶段 | 目标 | 关键交付 | 审计 |
|---|---|---|---|
| **B0–B4** 基础 | 单一真相的地基 | monorepo(pnpm workspace)+ runtime spike 定 bun(进程组信号 + bun:sqlite)· `@beaver/core` 契约(domain / 裁剪状态机 / config / errors / i18n / apiSchemas / pathSafety)· `@beaver/client`(BeaverClient over UDS)· SQLite repository + forward-only migrations · daemon 骨架(server / configService / gitService)。合并于 `bccbb8a`。 | grilling 定 D1–D22 |
| **B5** run pipeline | 一条 run 走完状态机 | SC2–11:LocalJsonTaskSource + factory · EventLog(append-only,monotonic seq)· WorkspaceManager(worktree,per-repo mutex)· TaskPackBuilder · AgentRunner(detached 进程组 + SIGINT→TERM→KILL)· VerifierRunner · HandoffBuilder(本地 PR 产物,**不 push**)· RunOrchestrator · run-control(stop/retry)· daemon API + SSE。 | SC3-5 / SC6/8 / SC9-11 各一轮 |
| **P1–P5** provider 层 | agent 可插拔 + 结构化事件 | AgentBackend 接口 + 归一化 AgentMessage · GenericBackend · claude-code(stream-json,stdin frame + control_request 自动批准)· pi(事件流 + tool-markup 消毒器)· codex(app-server JSON-RPC 2.0)· 接入 orchestrator(`provider` 字段 + createBackend)。 | ✅ SIGN-OFF(修 2 HIGH + 1 MEDIUM) |
| **B6** desktop | GUI client | `@beaver/ui`(25 控件改自 Multica,Apache-2.0 署名,tokens 换 Beaver 琥珀)· electron-vite 外壳(Main 三栏可拖拽 + 独立 **Preferences** 窗 `⌘,`)· daemon 接线(config 读写 / run 列表 / SSE 事件流,断线从 lastSeq 重连)。 | ✅ SIGN-OFF |
| **B7** Lark task source | 多源可插拔 | LarkCli(lark-cli 协议封死在 `taskSource/lark/`)· 无状态 fetch→map → ExternalTask(id 命名空间化,runner 覆盖入 raw)· factory 接线。设计:`TaskSource` + `ExternalTask` 是 seam,加 Linear/Slack = 新模块 + 一个 case。 | ✅ SIGN-OFF(修 1 HIGH + 1 MEDIUM) |
| **B8** 恢复 / resume / fix-loop | 韧性 | crash-recovery(启动和解僵尸 run:有 worktree→blocked_infra 可 resume,否则 aborted)· migration #2 `attempts.session_id` + 早 pin sessionId · resumeRun(复用 worktree + 上次 session 续跑)· fix-loop(verifier 失败带输出续 session 自动重试,`maxFixAttempts` 默认 0)。 | ✅ SIGN-OFF(修 2 HIGH) |
| **B9** publisher | 审批门控发布 | `runActions` 端点 + `orchestrator.runAction`:`ship_*/pipeline_status` 跑用户 ship 脚本(argv-safe,脚本 = 用户的 SCM adapter)· `prepare_handoff` 重建 handoff · 流 `tool.*` 事件。**调用 action = 显式批准**;ship 严格 gate 到 pr_ready;Beaver 自己绝不 push/merge。 | ⏳ 修 2 HIGH,re-audit 在飞 |

## 关键决策(D 系列,代码里体现的)

- **D3 裁剪状态机**:`RunStatus` 只保留有真实 producer 的态(status 作为 opaque TEXT,新态是廉价 append)。转移表是唯一权威(`core/stateMachine.ts`),side-effect 前先问它。B8 补了 `implementing↔blocked_infra` 支持 resume。
- **D4 UDS 传输**:daemon 走 `~/.beaver/daemon.sock`(0600),非 TCP。
- **D6 SQLite 唯一 SSOT**;**D7 attempts 一等公民 append-only**(fix-loop / resume 的底座);**D8 forward-only migrations**(user_version,拒绝更新的库)。
- **D10 便携性**:core/client 不依赖 Node/Bun 全局(tsconfig 拆分,bun-types 只在 daemon)。
- **D18 并发**:`maxConcurrentRuns` + per-repo prep mutex + **永不自动删 worktree**。
- **D19 resumable SSE**:`/events?since=<seq>` 单调 seq cursor,replay backlog + live,断线可续。
- **D20 local claim 派生自 runs**:run state 归 runs 表,task source 不自己存 status(所以 Lark 无状态、claim/update 是非变更 stub)。
- **多源 seam**:task source(`TaskSource`+`ExternalTask`)、agent provider(`AgentBackend`)、publisher(用户 ship 脚本)三处都是"归一化进统一表示、下游不认来源"的可插拔接缝;各来源特有的一切封死在各自 adapter,加新来源 = 新模块 + 一个 factory case。
- **session 复用**(B8):持久化 agent sessionId(backend 一 emit 就 pin,崩溃保凭据),resume/fix-loop 都续同一 session。

## 安全不变量(全程保持)

不自动 push、不 force-push、不删分支、不自动删 worktree、默认不执行 shell 字符串(argv-only spawn)、生成路径无 traversal / 无绝对或 `..` submodule 路径、sample 不存凭据、config 不 log secret、**未经显式批准不远程发布**、**Git/verifier/agent 失败绝不假成功**。B9 的发布靠"调用 action = 批准",merge 永远是人在 SCM 的手动步。

## 审计记录

每个阶段过 codex 独立 audit(session `beaver-audit`),累计 blocking findings 全部修复并复审:

- **provider 层**:HIGH(profile extraArgs 覆盖协议 flag)、HIGH(claude 无 result frame 却 completed)、MEDIUM(blockingExitCodes 未透传)→ SIGN-OFF。
- **B6 wiring**:无 blocking → SIGN-OFF(事件 buffer 无上界记为后续 follow-up)。
- **B7**:HIGH(rows/id 长度不匹配产假 id)、MEDIUM(权限错误被当瞬时 miss 吞)→ SIGN-OFF。
- **B8**:HIGH(resume 未清终态元数据)、HIGH(resume 违反 per-task active 守卫)→ SIGN-OFF。
- **B9**:HIGH(ship 未 gate 到 pr_ready,可能与 agent 并发改 worktree)、HIGH(spawn 失败无 error listener 崩 daemon)→ 修复,re-audit 在飞。

## 验证基线

`pnpm typecheck`(root + bun + ui + desktop node/web 共 5 项目)全绿;`pnpm test` = 47 vitest + 136 bun 全过。桌面 GUI 需真机 `pnpm rebuild electron`(下载 electron 二进制)后 `pnpm desktop`。

## 相关文档

- [design.md](../design.md) — B6 desktop 主题 / 控件来源与署名 / 窗口架构。

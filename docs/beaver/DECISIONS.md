# Beaver — Architecture Decision Log

Status: living document. Captures the production-build decisions made while grilling the Workcell prototype into Beaver. Each entry is a settled decision unless marked OPEN. "Rejected" records the road not taken so we do not relitigate it by accident.

Legend: **D** = decision, **Why** = load-bearing rationale, **Rejected** = alternative and why not.

---

## Naming & structure

### D1 — Beaver is a fresh production build; the prototype is read-only reference
- **D**: Build `Beaver/` from scratch against the target boundaries. The existing `src/` + `packages/` prototype stays untouched as proven reference. Full rebrand: `~/.beaver`, `BEAVER_HOME`, `@beaver/*` package scope, i18n `app.title = Beaver`.
- **Why**: DESIGN says optimize around boundaries, not the prototype file layout. A clean build lets us drop prototype debt (dual status vocabularies, dual read-back sources) instead of inheriting it.
- **Rejected**: migrate prototype in place → would carry the god files and the muddy source-of-truth semantics forward.

### D2 — Monorepo: `apps/` + `packages/`, self-contained pnpm workspace
- **D**: `Beaver/apps/{desktop,cli}` + `Beaver/packages/{core,client,daemon}`; own `pnpm-workspace.yaml`, installed independently of the prototype.
- **Why**: clients (desktop, cli) and libraries (core, client, daemon) separate cleanly; matches the documented component names.

---

## Runtime & process model

### D4 — Transport is a Unix domain socket, not TCP
- **D**: daemon listens on `~/.beaver/daemon.sock` (mode 0600). Clients use `http.request({ socketPath })`. No TCP port.
- **Why**: the daemon can start runs, spawn agents, and read worktree files. An unauthenticated `127.0.0.1` port is reachable by any local process AND by a browser page (localhost CSRF). A UDS is unreachable from a browser and gated by filesystem permissions — access control with less code than a token+origin scheme.
- **Rejected**: TCP + bearer token + origin allowlist → more moving parts, still browser-reachable.

### D10 — Execution plane runs on Bun; Electron main stays Node; shared code portable to both
- **D**: `cli` + `daemon` run on **Bun**. Electron main runs on Electron's bundled Node (thin client only). `@beaver/core` + `@beaver/client` must run on **both** Bun and Node ≥ 20 (no `bun:`/`node:sqlite` imports in shared code). The execution-plane runtime version is pinned to one version (same whether launched by CLI or Electron), so a future driver switch needs one ABI.
- **Why**: verified by spike — Bun's detached process groups (`kill(-pgid, SIGTERM)`), SIGKILL escalation, `bun:sqlite` (WAL/tx/prepared), and `@beaver/core` all work. Bun gives native TS, fast CLI start, single-binary output, and `bun:sqlite` (stable) as the store. Electron cannot run on Bun (V8/Chromium-bound), but that constrains nothing because main owns no execution.
- **Rejected**: Node + `node:sqlite` (experimental/RC — see D9); mixing Node-cli with Bun-daemon (two runtimes for no gain, since the daemon needs Bun-or-Node anyway).

### D11 — CLI ships as a binary via `bun build --compile`, not Go/Rust
- **D**: keep the CLI in TypeScript, compile to a self-contained binary with Bun.
- **Why**: a native CLI cannot import `@beaver/core`/`@beaver/client`, so it would re-implement the contract (i18n catalogs, error→message, error→exit-code, endpoint list) in a second language → cross-language drift. Bun `--compile` already yields a single fast binary with native contract sharing.
- **Rejected**: Go (best native fit, but forces contract codegen/JSON across a language boundary; only wins on binary size ~8 MB vs ~60 MB — not worth a second language on a TS stack) and Rust (overkill for a thin UDS/HTTP/JSON client; no other Rust in the stack). Revisit Go only if a <10 MB binary becomes a hard requirement.

### D12 — Adopt Bun as runtime only; keep pnpm + vitest + Vite
- **D**: pnpm stays the package manager; Vite/electron-vite stays for the renderer; vitest stays for now. Bun is the runtime for cli/daemon and the CLI bundler.
- **Why**: judge tooling by whether it serves Beaver, not by trend. Switching package manager risks Electron native-dep compat for no benefit. Revisit the test runner at B5 (bun:sqlite / child_process code should be tested under the real Bun runtime, likely `bun test` for those packages).

### D16 — Desktop shell is Electron now, kept swappable for Electrobun later
- **D**: use Electron for the desktop shell. Build the shell as a thin, swappable adapter with a pure-web renderer and an abstracted daemon transport, so switching to Electrobun (Bun-native, system-webview) later is a bounded change.
- **Why**: Electrobun would fully unify the runtime on Bun and shrink binaries, and our thin-client shell makes it low-risk — but it is 0.x/young; betting a daily-driver shell on it now is premature. The architecture makes the choice cheap to defer: heavy logic lives in the Bun daemon behind UDS, so the shell is small. Re-evaluate with a real spike at B6; Electron is the safe fallback.

---

## Domain & persistence

### D3 — State machine is trimmed to the MVP-produced subset and grows; status persists as opaque TEXT
- **D**: `RunStatus` includes only states with a real producer now (`discovered, claimed, preparing_workspace, implementing, verifying, pr_ready, done, aborted` + the block reasons the agent/verifier actually classify). The full DESIGN vocabulary (`planning, plan_ready, reviewing, fixing, pr_opened`, remaining `blocked_*`) is roadmap, added when its phase lands. SQLite `status` is a plain `TEXT` column, validated in the app layer.
- **Why**: persisted/written-back enum values are the expensive-to-reverse seam (renaming needs data + external-Base migration); adding a state is cheap (union + one transition row + two i18n entries + one pill mapping). Grow-is-cheap, shrink-is-expensive → start lean. TEXT column means adding a state needs zero DB migration.
- **Rejected**: encode all 20 DESIGN states now → dead branches with no producers and unused persisted enum values.

### D6 — SQLite is the sole source of truth; files are a write-only mirror
- **D**: all reads go through the SQLite repositories. `run.json`, `events.jsonl`, `*.log` are written for human inspection and blocked-handoff only, never read back as truth on the hot path. Recovery is an explicit `beaver runs import <dir>` command, not an automatic file fallback.
- **Why**: the prototype's silent "DB miss → rebuild from files" is a silent-fallback anti-pattern that hides real bugs, and two authoritative sources drift. One truth source makes every repository method unambiguous. Durability is preserved via the JSONL mirror + explicit import.
- **Rejected**: prototype dual read-back (getRun file fallback, listRuns fs scan, readEvents file import).

### D7 — Attempts are first-class and append-only
- **D**: Task → many Runs (retry = a new immutable Run, new worktree). Run → many Attempts (each phase execution). Resume/fix append a new Attempt to the same run. The `runs` table keeps only current-state + execution pointer + aggregate (`status, base_branch, base_commit, attempt_count, current_pid, heartbeat_at, pr_url, block_reason, block_message`, timestamps); per-execution `command/args/stdout/exit` move to `attempts`. An attempt is inserted at phase start, finalized once at end, then immutable.
- **Why**: even MVP runs ≥2 phase executions (implement + verify), each with its own stdout/exit — attempts are the honest model now, not future-proofing. Reshaping a live `runs` table into attempts later needs migration + backfill. B8's fix loop is append-attempts by nature.
- **Rejected**: prototype run-holds-current-attempt (resume overwrites and loses history).

### D8 — `PRAGMA user_version` forward-only migrations from day 1
- **D**: on daemon start, in a transaction, run migrations numbered above the current `user_version` and bump it. Migration #1 is the initial schema. Forward-only, no down migrations.
- **Why**: the first real migration otherwise faces version-less DBs and needs schema-sniffing to recover state. Establishing the anchor now makes every future change a clean append. `IF NOT EXISTS` cannot add/alter columns.
- **Rejected**: `CREATE TABLE IF NOT EXISTS` only (prototype); down migrations (pointless for a local single-user DB — fix forward, or rebuild from the JSONL mirror).

### D9 — SQLite driver is `bun:sqlite`, hidden behind `RunRepository`
- **D**: use Bun's built-in `bun:sqlite`. All SQL lives behind the `RunRepository` interface.
- **Why**: `bun:sqlite` is stable (unlike `node:sqlite`, which is RC/experimental and emits runtime warnings), synchronous, fast, zero native dep. It is the reason D10 lands on Bun for the store. Behind the repository, swapping to better-sqlite3 is a one-class change if ever forced.
- **Rejected**: `node:sqlite` (experimental; also unavailable in Electron's Node 20 — moot once the daemon is a Bun binary); better-sqlite3 (native ABI/rebuild tax we do not need since the daemon is an out-of-process Bun binary, and the SSOT deserves the stable built-in).

---

## API, CLI, i18n

### D5 — Shared `@beaver/client`, presentation-free
- **D**: one `@beaver/client` package does transport + contract decoding only: connect UDS, return typed data per `ApiResponses`, and on non-2xx decode `ApiErrorBody` into `throw BeaverError`. No localization, no rendering. Consumed by cli and (until Electrobun) electron-main.
- **Why**: docs forbid duplicating daemon-call logic across clients. A presentation-free client is the single source for "how to call the daemon"; each client localizes on its own (CLI catalog, renderer I18nProvider).
- **Rejected**: hand-rolled request logic per client (prototype already drifted between cli and electron-main).

### D8b — Zod request validation at the daemon boundary; schema is the single source
- **D**: every endpoint with a body has a zod request schema, parsed at the daemon entry; failure → `BeaverError('BAD_REQUEST', { detail })`. Types are `z.infer`red from the schema (one source). Responses are not validated (internal, trusted).
- **Why**: "strict in, precise out." The daemon is a code-executing control plane; its entry is the trust boundary and must fail-fast on malformed input, not dig fields with hand-rolled `requireString`. Guards against buggy/version-mismatched clients, not only attackers.

### D14 — Stable CLI exit codes mapped in core
- **D**: `0` success, `1` execution/validation failure, `2` blocked/retryable, `3` config/environment. `exitCodeForError(code)` in `@beaver/core` is the single mapping.

### D15 — i18n: daemon returns codes, clients localize; catalogs are compile-time-exhaustive
- **D**: daemon returns stable error codes + params; clients render. Catalogs typed `Record<MessageKey, string>` so a missing translation fails `tsc` (primary gate), plus a runtime parity test. Locales: `en-US`, `zh-CN`. Enum values / event types / config keys / API fields stay English.

### D17 — Contract hygiene
- **D**: `automation` config is optional with no default paths (a fresh config never leaks a specific machine's filesystem). `TaskSourceType` = `larkBase | localJson | githubIssue | linear` (drop prototype `owl`).

---

## Concurrency

### D18 — Bounded run concurrency; per-repo prep serialized; worktrees never auto-deleted
- **D**: the single daemon is the only orchestrator (enforced by binding the UDS as a mutex; a second daemon hits EADDRINUSE and exits, stale socket is probed then unlinked). Runs execute concurrently up to `maxConcurrentRuns` (default 2); starting beyond the limit returns `RUN_BLOCKED` (exit 2), no queue/scheduler in MVP (deferred to the auto-start era). `WorkspaceManager` holds a per-repo async mutex that serializes the shared-`.git` prep mutations — `fetch --all --prune`, `worktree add`, `submodule init` — while agent/verifier phases run concurrently in isolated worktrees with no lock. Worktrees are never auto-deleted.
- **Why**: prior art (claude-squad, cmux) uses the same isolated-worktree-per-agent model, and the failure modes are documented in anthropics/claude-code #34645 (concurrent `git worktree add` races on `.git/config.lock`) and #55724 (lock contention → failed commit → agent exit → auto-cleanup destroys uncommitted work). The convergent fix is exactly a mutex/queue serializing `worktree add`. A linked worktree's index is per-worktree (`.git/worktrees/<name>/index.lock`), so commits in isolated worktrees do not contend — only the shared-`.git` prep mutations do. The auto-cleanup footgun validates Beaver's existing "no automatic worktree deletion" invariant.
- **Rejected**: unbounded concurrency (resource blowup + lock races); a real queue/scheduler now (belongs with auto-start, needs a producer for a `queued` state per D3); no lock + rely on git's own locking (documented to fail under same-repo concurrency, and a failed prep can cascade to lost work). Retry-with-backoff + jitter are acceptable optional defense-in-depth on top of the mutex, not a replacement.

## Event stream

### D19 — Resumable SSE with a monotonic `seq` cursor (gap-free catch-up)
- **D**: the `events` table carries a monotonic `seq` (SQLite `INTEGER PRIMARY KEY`/rowid, global total order). One SSE endpoint `GET /events?runId=<id>&since=<seq>`: the server first replays persisted events with `seq > since` from SQLite, then switches to live tail on the same connection — no snapshot-then-subscribe race, gap-free reconnect. Each SSE frame sets `id: <seq>`. Run events are durable and replayable; task-changed events are ephemeral "poke → refetch /tasks" signals (not seq'd). `GET /runs/:id/events` remains a one-shot snapshot for `--json`/non-follow. If `since` is unknown/too old, fall back to a full replay. Keep-alive via periodic SSE comment ping.
- **Why**: industry-standard, spec-blessed. SSE `id:` + `Last-Event-ID` resumption is in the WHATWG HTML spec §9.2 / MDN; monotonic-sequence + resume-from-offset is the canonical event-stream pattern (EventStore/Kurrent, NATS, AT Protocol backfill, Salesforce Platform Events). The snapshot↔subscribe race is a documented failure the cursor eliminates. Designing the cursor now is cheap (one `seq` column, echo as SSE `id`); retrofitting a protocol clients already built against is expensive.
- **Rejected**: live-only stream + separate historical fetch (prototype) → dropped/duplicated events on mid-run join or reconnect; per-run + global as two endpoints (the `?runId` filter unifies them, matching the recommended `$all` + server-side-filter approach); timestamp as cursor (not monotonic/unique).

## Open / deferred

- **B6 runtime packaging**: bundle the pinned Bun runtime / ship the `bun build --compile` daemon binary so Electron just execs it (dissolves the "which Node runs the daemon" problem).
- **B6 shell spike**: real Electrobun-vs-Electron evaluation (React+Vite DX, WKWebView rendering of design tokens, RPC to daemon, updater).
- **B5 test runner**: decide `bun test` vs vitest for bun:sqlite/child_process packages.
- **D20 — local claim derives from runs** (settled): "is this task busy" = does it have an active run (non-terminal, non-blocked) — a synchronous check+insert transaction in the single daemon enforces one active run per task. No local claims table. `tasks.runner_*` columns are a cache of the EXTERNAL source's runner projection (inbound on poll), not a local claim store; dormant until Lark (B7). The distributed Lark claim + lease/expiry is B7.
### D21 — CLI shape (settled inline at B4)
- **D**: hand-rolled dispatch over `node:util` `parseArgs` (stdlib, no CLI-framework dep). Namespaced `beaver <noun> <verb> [args] [--json] [--lang]`. `--json` prints compact machine JSON; human mode pretty-prints data and localizes messages/errors. Exit codes from `exitCodeForError` (0/1/2/3); `repo validate` returns exit 1 for a non-worktree. Locale resolution order: `--lang` → `BEAVER_LANG` → `LC_ALL` → `LANG` (POSIX precedence: LC_ALL overrides LANG; system vars normalized `zh_CN.UTF-8`→`zh-CN`, non-locales like `C.UTF-8` fall through) → `en-US`. `config set` validates stdin BEFORE contacting the daemon, so a local BAD_REQUEST spawns nothing. Error localization must also read `--lang` from argv (the top-level catch is outside the parsed context).
- **Why**: stdlib-preference; the command set is bounded and simple. The CLI only calls `@beaver/client`; zero orchestration.

### D22 — Daemon lifecycle & discovery (settled inline at B4)
- **D**: the daemon writes `<home>/daemon.pid` on start (removed on graceful stop). `beaver daemon start` and any command needing the daemon auto-spawn a detached `bun <daemon> serve` (entry overridable via `BEAVER_DAEMON_ENTRY` for packaged binaries) and wait for `/health`. `daemon status` probes without spawning (exit 3 if down). `daemon stop` reads the pidfile and sends SIGTERM.
- **Test gotcha (recorded)**: a spawnSync CLI child cannot talk to an in-process (same-worker) daemon — spawnSync freezes the server's event loop → deadlock. CLI E2E must let the CLI auto-spawn a SEPARATE daemon process.

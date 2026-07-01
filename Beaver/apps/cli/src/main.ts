import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BeaverClient } from '@beaver/client';
import {
  BeaverError,
  DEFAULT_LOCALE,
  EXIT,
  beaverPaths,
  exitCodeForError,
  formatApiError,
  formatMessage,
  isLocale,
  type BeaverPaths,
  type ExitCode,
  type Locale,
  type ToolAction
} from '@beaver/core';

/**
 * Beaver CLI — a thin client over the daemon (D5). It never runs git/agent/
 * orchestration; it only calls the daemon API and renders results. Human text
 * is localized from the i18n catalog; `--json` prints stable machine output;
 * exit codes come from `exitCodeForError` (0 ok / 1 fail / 2 blocked / 3 config).
 */

type Ctx = {
  json: boolean;
  locale: Locale;
  paths: BeaverPaths;
  client: BeaverClient;
  values: Record<string, unknown>;
};

const cliDir = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: 'boolean', default: false },
      lang: { type: 'string' },
      location: { type: 'string' }
    },
    allowPositionals: true,
    strict: false
  });

  const paths = beaverPaths();
  const ctx: Ctx = {
    json: values.json === true,
    locale: resolveLocale(values.lang as string | undefined, process.env),
    paths,
    client: new BeaverClient(paths.socketPath),
    values
  };

  const [noun, verb, ...rest] = positionals;
  if (!noun || noun === 'help') {
    printHelp();
    return;
  }

  await dispatch(ctx, noun, verb, rest);
}

async function dispatch(ctx: Ctx, noun: string, verb: string | undefined, rest: string[]): Promise<void> {
  switch (noun) {
    case 'daemon':
      return daemonCommand(ctx, verb);
    case 'config':
      return configCommand(ctx, verb);
    case 'repo':
      return repoCommand(ctx, verb, rest);
    case 'tasks':
      return tasksCommand(ctx, verb, rest);
    case 'runs':
      return runsCommand(ctx, verb, rest);
    case 'open':
      return openCommand(ctx, verb);
    default:
      throw new BeaverError('BAD_REQUEST', { detail: `unknown command: ${noun}` });
  }
}

// ---- daemon lifecycle ----

async function daemonCommand(ctx: Ctx, verb: string | undefined): Promise<void> {
  if (verb === 'start') {
    await ensureDaemon(ctx);
    printMessage(ctx, 'cli.daemon.started', { socket: ctx.paths.socketPath });
    return;
  }
  if (verb === 'status') {
    try {
      const health = await ctx.client.health();
      printData(ctx, health);
    } catch (error) {
      if (error instanceof BeaverError && error.code === 'DAEMON_UNAVAILABLE') {
        printMessage(ctx, 'cli.daemon.notRunning');
        process.exitCode = EXIT.CONFIG;
        return;
      }
      throw error;
    }
    return;
  }
  if (verb === 'stop') {
    const pid = await readPid(ctx.paths.pidPath);
    if (pid === undefined) {
      printMessage(ctx, 'cli.daemon.notRunning');
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
    printMessage(ctx, 'cli.daemon.stopped');
    return;
  }
  throw new BeaverError('BAD_REQUEST', { detail: 'usage: beaver daemon <start|stop|status>' });
}

// ---- config ----

async function configCommand(ctx: Ctx, verb: string | undefined): Promise<void> {
  if (verb === 'get') {
    await ensureDaemon(ctx);
    printData(ctx, await ctx.client.getConfig());
    return;
  }
  if (verb === 'set') {
    // Validate local input BEFORE touching the daemon, so a purely local
    // BAD_REQUEST never spawns a daemon as a side effect.
    const raw = await readStdin();
    if (raw.trim().length === 0) {
      throw new BeaverError('BAD_REQUEST', { detail: 'config set reads JSON from stdin' });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BeaverError('BAD_REQUEST', { detail: 'stdin is not valid JSON' });
    }
    await ensureDaemon(ctx);
    printData(ctx, await ctx.client.setConfig(parsed as never));
    return;
  }
  throw new BeaverError('BAD_REQUEST', { detail: 'usage: beaver config <get|set>' });
}

// ---- repo ----

async function repoCommand(ctx: Ctx, verb: string | undefined, rest: string[]): Promise<void> {
  if (verb !== 'validate') {
    throw new BeaverError('BAD_REQUEST', { detail: 'usage: beaver repo validate <path>' });
  }
  const repoPath = requireArg(rest[0], 'path');
  await ensureDaemon(ctx);
  const result = await ctx.client.validateRepo(repoPath);
  printData(ctx, result);
  if (!result.isGitWorktree) {
    process.exitCode = EXIT.FAILURE;
  }
}

// ---- tasks ----

async function tasksCommand(ctx: Ctx, verb: string | undefined, rest: string[]): Promise<void> {
  await ensureDaemon(ctx);
  switch (verb) {
    case 'list':
      return printData(ctx, await ctx.client.listTasks());
    case 'sync':
      return printData(ctx, await ctx.client.syncTasks());
    case 'claim':
      return printData(ctx, await ctx.client.claimTask(requireArg(rest[0], 'task-id')));
    default:
      throw new BeaverError('BAD_REQUEST', { detail: 'usage: beaver tasks <list|sync|claim <task-id>>' });
  }
}

// ---- runs ----

async function runsCommand(ctx: Ctx, verb: string | undefined, rest: string[]): Promise<void> {
  await ensureDaemon(ctx);
  const runId = (): string => requireArg(rest[0], 'run-id');
  switch (verb) {
    case 'list':
      return printData(ctx, await ctx.client.listRuns());
    case 'start':
      return printData(ctx, await ctx.client.startRun(requireArg(rest[0], 'task-id')));
    case 'get':
      return printData(ctx, await ctx.client.getRun(runId()));
    case 'stop':
      return printData(ctx, await ctx.client.stopRun(runId()));
    case 'retry':
      return printData(ctx, await ctx.client.retryRun(runId()));
    case 'resume':
      return printData(ctx, await ctx.client.resumeRun(runId()));
    case 'logs':
      return printData(ctx, await ctx.client.runLogs(runId()));
    case 'events':
      return printData(ctx, await ctx.client.runEvents(runId()));
    case 'files':
      return printData(ctx, await ctx.client.runFiles(runId()));
    case 'git-status':
      return printData(ctx, await ctx.client.runGitStatus(runId()));
    case 'handoff':
      return printData(ctx, await ctx.client.runHandoff(runId()));
    case 'actions':
      return printData(ctx, await ctx.client.runAction(runId(), requireArg(rest[1], 'action') as ToolAction));
    default:
      throw new BeaverError('BAD_REQUEST', {
        detail: 'usage: beaver runs <list|start|get|stop|retry|resume|logs|events|files|git-status|handoff|actions>'
      });
  }
}

// ---- open ----

async function openCommand(ctx: Ctx, runId: string | undefined): Promise<void> {
  await ensureDaemon(ctx);
  const run = await ctx.client.getRun(requireArg(runId, 'run-id'));
  if (process.platform === 'darwin') {
    spawnSync('open', [run.worktreePath], { stdio: 'inherit' });
  } else {
    process.stdout.write(`${run.worktreePath}\n`);
  }
}

// ---- helpers ----

async function ensureDaemon(ctx: Ctx): Promise<void> {
  if (await isHealthy(ctx.client)) {
    return;
  }
  const entry = process.env.BEAVER_DAEMON_ENTRY ?? path.resolve(cliDir, '../../../packages/daemon/src/main.ts');
  const child = spawn('bun', [entry, 'serve'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isHealthy(ctx.client)) {
      return;
    }
    await delay(150);
  }
  throw new BeaverError('DAEMON_UNAVAILABLE', { socket: ctx.paths.socketPath });
}

async function isHealthy(client: BeaverClient): Promise<boolean> {
  try {
    await client.health();
    return true;
  } catch {
    return false;
  }
}

function resolveLocale(langFlag: string | undefined, env: NodeJS.ProcessEnv): Locale {
  // Precedence: --lang > BEAVER_LANG > LC_ALL > LANG (POSIX: LC_ALL overrides
  // LANG). Each system var is normalized (`zh_CN.UTF-8` -> `zh-CN`) and tried
  // independently, so a non-locale like `C.UTF-8` falls through instead of
  // masking a valid LC_ALL.
  const candidates = [langFlag, env.BEAVER_LANG, normalizeLang(env.LC_ALL), normalizeLang(env.LANG)];
  for (const candidate of candidates) {
    if (candidate && isLocale(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_LOCALE;
}

function normalizeLang(lang: string | undefined): string | undefined {
  if (!lang) {
    return undefined;
  }
  return lang.split('.')[0]!.replace('_', '-');
}

function printData(ctx: Ctx, data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, ctx.json ? 0 : 2)}\n`);
}

function printMessage(ctx: Ctx, key: Parameters<typeof formatMessage>[1], params: Record<string, string | number> = {}): void {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify({ message: formatMessage(ctx.locale, key, params) })}\n`);
  } else {
    process.stdout.write(`${formatMessage(ctx.locale, key, params)}\n`);
  }
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) {
    throw new BeaverError('BAD_REQUEST', { detail: `missing ${label}` });
  }
  return value;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readPid(pidPath: string): Promise<number | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  process.stdout.write(`beaver — local development loop runner

Usage: beaver <command> [args] [--json] [--lang en-US|zh-CN]

  daemon start|stop|status
  config get | config set        (set reads JSON from stdin)
  repo validate <path>
  tasks list|sync|claim <task-id>
  runs list
  runs start <task-id>
  runs get|stop|retry|resume|logs|events|files|git-status|handoff <run-id>
  runs actions <run-id> <action>
  open <run-id>

Exit codes: 0 ok · 1 failure · 2 blocked/retryable · 3 config/environment
`);
}

function argvLang(): string | undefined {
  const argv = process.argv;
  const index = argv.indexOf('--lang');
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  const inline = argv.find((arg) => arg.startsWith('--lang='));
  return inline ? inline.slice('--lang='.length) : undefined;
}

function renderError(error: unknown): ExitCode {
  const locale = resolveLocale(argvLang(), process.env);
  const wantJson = process.argv.includes('--json');
  if (error instanceof BeaverError) {
    const text = wantJson ? JSON.stringify(error.toBody()) : formatApiError(locale, error.toBody());
    process.stderr.write(`${text}\n`);
    return exitCodeForError(error.code);
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT.FAILURE;
}

void main().catch((error) => {
  process.exit(renderError(error));
});

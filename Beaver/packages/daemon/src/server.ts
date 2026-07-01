import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BeaverError,
  REQUEST_SCHEMAS,
  beaverPaths,
  type ApiErrorBody,
  type BeaverConfig,
  type BeaverErrorCode,
  type BeaverPaths,
  type HealthResponse,
  type RunEvent
} from '@beaver/core';
import { ConfigService } from './configService';
import { GitService } from './gitService';
import { RunRepository } from './repository/runRepository';
import { EventLog } from './eventLog';
import { WorkspaceManager } from './workspace';
import { TaskPackBuilder } from './taskPack';
import { AgentRunner } from './agent';
import { VerifierRunner } from './verifier';
import { HandoffBuilder } from './handoff';
import { RunOrchestrator } from './orchestrator';
import { createTaskSource, resolveConfiguredPath } from './taskSource';
import { BEAVER_VERSION } from './version';

const HTTP_STATUS: Partial<Record<BeaverErrorCode, number>> = {
  BAD_REQUEST: 400,
  CONFIG_INVALID: 400,
  REPO_INVALID: 400,
  SUBMODULE_INVALID: 400,
  NOT_FOUND: 404,
  RUN_BLOCKED: 409,
  NOT_IMPLEMENTED: 501
};

type SseClient = { response: ServerResponse; minSeq: number; runId?: string };

export class BeaverDaemonServer {
  private readonly configService: ConfigService;
  private repo!: RunRepository;
  private eventLog!: EventLog;
  private orchestrator!: RunOrchestrator;
  private readonly sseClients = new Set<SseClient>();
  private readonly server = http.createServer((request, response) => void this.handle(request, response));

  constructor(private readonly paths: BeaverPaths = beaverPaths()) {
    this.configService = new ConfigService(paths.configPath);
  }

  get socketPath(): string {
    return this.paths.socketPath;
  }

  async start(): Promise<{ socketPath: string }> {
    await fs.mkdir(this.paths.home, { recursive: true });
    const config = await this.configService.get();
    this.repo = new RunRepository(this.paths.dbPath);
    this.eventLog = new EventLog(this.repo, this.paths.runsDir);
    this.eventLog.on((event) => this.broadcast(event));
    this.orchestrator = new RunOrchestrator({
      repo: this.repo,
      eventLog: this.eventLog,
      workspace: new WorkspaceManager(config.gitBinary),
      taskPack: new TaskPackBuilder(),
      agentRunner: new AgentRunner(),
      verifier: new VerifierRunner(),
      handoff: new HandoffBuilder(),
      runsDir: this.paths.runsDir,
      workspaceRoot: resolveConfiguredPath(config.workspaceRoot, process.env)
    });

    // Crash recovery (B8): reconcile runs orphaned by a previous daemon before
    // the socket accepts clients, so no client ever observes a zombie active run.
    const recovered = await this.orchestrator.recoverInterruptedRuns();
    if (recovered.length > 0) {
      process.stdout.write(`beaver-daemon recovered ${recovered.length} interrupted run(s) -> aborted\n`);
    }

    await this.clearStaleSocket();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.paths.socketPath, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    try {
      await fs.chmod(this.paths.socketPath, 0o600);
      await fs.writeFile(this.paths.pidPath, `${process.pid}\n`, 'utf8');
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
    return { socketPath: this.paths.socketPath };
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      client.response.end();
    }
    this.sseClients.clear();
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(this.paths.socketPath, { force: true });
    await fs.rm(this.paths.pidPath, { force: true });
    this.repo?.close();
  }

  private async clearStaleSocket(): Promise<void> {
    try {
      await fs.access(this.paths.socketPath);
    } catch {
      return;
    }
    const healthy = await this.probeHealth();
    if (healthy) {
      throw new BeaverError('INTERNAL', { detail: 'another Beaver daemon is already running' });
    }
    await fs.rm(this.paths.socketPath, { force: true });
  }

  private probeHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const request = http.request(
        { socketPath: this.paths.socketPath, path: '/health', method: 'GET', timeout: 500 },
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        }
      );
      request.on('error', () => resolve(false));
      request.on('timeout', () => {
        request.destroy();
        resolve(false);
      });
      request.end();
    });
  }

  private broadcast(event: RunEvent): void {
    const frame = `event: run\nid: ${event.seq ?? ''}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      if (client.runId && client.runId !== event.runId) {
        continue; // server-side runId filter (D19)
      }
      if ((event.seq ?? 0) > client.minSeq) {
        client.response.write(frame);
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/events') {
      this.handleEvents(url, response);
      return;
    }
    try {
      sendJson(response, 200, await this.route(request, url));
    } catch (error) {
      let beaverError: BeaverError;
      if (error instanceof BeaverError) {
        beaverError = error;
      } else {
        process.stderr.write(
          `[beaver-daemon] unhandled request error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
        );
        beaverError = new BeaverError('INTERNAL');
      }
      const body: ApiErrorBody = beaverError.toBody();
      sendJson(response, HTTP_STATUS[beaverError.code] ?? 500, body);
    }
  }

  private async route(request: IncomingMessage, url: URL): Promise<unknown> {
    const method = request.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean);

    if (method === 'GET' && url.pathname === '/health') {
      return { ok: true, service: 'beaver-daemon', version: BEAVER_VERSION } satisfies HealthResponse;
    }
    if (method === 'GET' && url.pathname === '/config') {
      return this.configService.get();
    }
    if (method === 'POST' && url.pathname === '/config') {
      const parsed = REQUEST_SCHEMAS.configSet.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        throw new BeaverError('CONFIG_INVALID', { detail: issues(parsed.error) });
      }
      return this.configService.save(parsed.data);
    }
    if (method === 'POST' && url.pathname === '/repo/validate') {
      const parsed = REQUEST_SCHEMAS.repoValidate.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        throw new BeaverError('BAD_REQUEST', { detail: 'repoPath is required' });
      }
      const config = await this.configService.get();
      return new GitService(config.gitBinary).validateRepo(parsed.data.repoPath);
    }
    if (method === 'GET' && url.pathname === '/tasks') {
      return this.repo.listTasks();
    }
    if (method === 'POST' && url.pathname === '/tasks/sync') {
      const config = await this.configService.get();
      const tasks = await createTaskSource(config).pollAssignedTasks();
      this.repo.upsertTasks(tasks);
      return { tasks };
    }
    if (method === 'GET' && url.pathname === '/runs') {
      return this.repo.listRuns();
    }
    if (method === 'POST' && url.pathname === '/runs/start') {
      const parsed = REQUEST_SCHEMAS.runsStart.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        throw new BeaverError('BAD_REQUEST', { detail: 'taskId is required' });
      }
      const config = await this.configService.get();
      return this.orchestrator.startRun(parsed.data.taskId, config, this.repo.listTasks());
    }
    if (parts[0] === 'runs' && parts[1]) {
      return this.routeRun(method, safeDecode(parts[1]), parts.slice(2));
    }
    throw new BeaverError('NOT_FOUND', { resource: 'route', id: `${method} ${url.pathname}` });
  }

  private async routeRun(method: string, runId: string, tail: string[]): Promise<unknown> {
    if (method === 'GET' && tail.length === 0) {
      return this.requireRun(runId);
    }
    if (method === 'POST' && tail[0] === 'stop') {
      this.requireRun(runId);
      return this.orchestrator.stopRun(runId);
    }
    if (method === 'POST' && tail[0] === 'retry') {
      this.requireRun(runId);
      return this.orchestrator.retryRun(runId, await this.configService.get(), this.repo.listTasks());
    }
    if (method === 'GET' && tail[0] === 'events') {
      this.requireRun(runId);
      return this.repo.readEventsSince(0, runId);
    }
    if (method === 'GET' && tail[0] === 'logs') {
      const run = this.requireRun(runId);
      const runDir = path.join(this.paths.runsDir, run.id);
      const [stdout, stderr, verifier] = await Promise.all([
        readOptionalFile(path.join(runDir, 'stdout.log')),
        readOptionalFile(path.join(runDir, 'stderr.log')),
        readOptionalFile(path.join(runDir, 'verifier.log'))
      ]);
      return { stdout, stderr, verifier };
    }
    if (method === 'GET' && tail[0] === 'git-status') {
      const run = this.requireRun(runId);
      const config = await this.configService.get();
      return new GitService(config.gitBinary).getStatus(run.worktreePath);
    }
    throw new BeaverError('NOT_IMPLEMENTED', { feature: `${method} /runs/${runId}/${tail.join('/')}` });
  }

  private requireRun(runId: string) {
    const run = this.repo.getRun(runId);
    if (!run) {
      throw new BeaverError('NOT_FOUND', { resource: 'run', id: runId });
    }
    return run;
  }

  private handleEvents(url: URL, response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    response.write('event: ready\ndata: {"ok":true}\n\n');
    const rawSince = Number(url.searchParams.get('since') ?? '0');
    const since = Number.isFinite(rawSince) ? rawSince : 0; // a malformed cursor tails from the start
    const runId = url.searchParams.get('runId') ?? undefined;

    // Synchronous: replay the backlog, then subscribe live above the last
    // replayed seq — no await between, so no event can slip through or double.
    const backlog = this.repo.readEventsSince(since, runId);
    let lastSeq = since;
    for (const event of backlog) {
      response.write(`event: run\nid: ${event.seq ?? ''}\ndata: ${JSON.stringify(event)}\n\n`);
      lastSeq = event.seq ?? lastSeq;
    }
    const client: SseClient = { response, minSeq: lastSeq, runId };
    this.sseClients.add(client);
    response.on('close', () => this.sseClients.delete(client));
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BeaverError('BAD_REQUEST', { detail: 'request body is not valid JSON' });
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function issues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BeaverError('BAD_REQUEST', { detail: 'invalid percent-encoding in path' });
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

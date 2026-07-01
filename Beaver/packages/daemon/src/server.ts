import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BeaverError,
  REQUEST_SCHEMAS,
  type ApiErrorBody,
  type BeaverErrorCode,
  type HealthResponse
} from '@beaver/core';
import { ConfigService } from './configService';
import { GitService } from './gitService';
import { beaverPaths, type BeaverPaths } from './paths';
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

function statusForError(code: BeaverErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

export class BeaverDaemonServer {
  private readonly configService: ConfigService;
  private readonly server = http.createServer((request, response) => {
    void this.handle(request, response);
  });

  constructor(private readonly paths: BeaverPaths = beaverPaths()) {
    this.configService = new ConfigService(paths.configPath);
  }

  get socketPath(): string {
    return this.paths.socketPath;
  }

  async start(): Promise<{ socketPath: string }> {
    await fs.mkdir(this.paths.home, { recursive: true });
    await this.clearStaleSocket();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(new BeaverError('INTERNAL', { detail: 'another Beaver daemon is already listening on the socket' }));
          return;
        }
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.paths.socketPath, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    // If any post-listen step fails, tear the server + socket back down so a
    // failed start() never leaves a daemon serving without a valid pidfile.
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
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(this.paths.socketPath, { force: true });
    await fs.rm(this.paths.pidPath, { force: true });
  }

  /** If a socket file is left over, keep it only when a live daemon answers; otherwise unlink it. */
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const result = await this.route(request);
      sendJson(response, 200, result);
    } catch (error) {
      let beaverError: BeaverError;
      if (error instanceof BeaverError) {
        beaverError = error;
      } else {
        // Log the real error server-side; never leak raw runtime/fs detail over
        // the wire as a stable response field.
        process.stderr.write(
          `[beaver-daemon] unhandled request error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
        );
        beaverError = new BeaverError('INTERNAL');
      }
      const body: ApiErrorBody = beaverError.toBody();
      sendJson(response, statusForError(beaverError.code), body);
    }
  }

  private async route(request: IncomingMessage): Promise<unknown> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/health') {
      const body: HealthResponse = { ok: true, service: 'beaver-daemon', version: BEAVER_VERSION };
      return body;
    }
    if (method === 'GET' && pathname === '/config') {
      return this.configService.get();
    }
    if (method === 'POST' && pathname === '/config') {
      const body = await readJsonBody(request);
      const parsed = REQUEST_SCHEMAS.configSet.safeParse(body);
      if (!parsed.success) {
        throw new BeaverError('CONFIG_INVALID', {
          detail: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        });
      }
      return this.configService.save(parsed.data);
    }
    if (method === 'POST' && pathname === '/repo/validate') {
      const body = await readJsonBody(request);
      const parsed = REQUEST_SCHEMAS.repoValidate.safeParse(body);
      if (!parsed.success) {
        throw new BeaverError('BAD_REQUEST', { detail: 'repoPath is required' });
      }
      const config = await this.configService.get();
      return new GitService(config.gitBinary).validateRepo(parsed.data.repoPath);
    }

    // Known-but-unimplemented routes fail loudly rather than 404 (wired in B5/B7).
    if (isKnownRoute(method, pathname)) {
      throw new BeaverError('NOT_IMPLEMENTED', { feature: `${method} ${pathname}` });
    }
    throw new BeaverError('NOT_FOUND', { resource: 'route', id: `${method} ${pathname}` });
  }
}

const KNOWN_PREFIXES = ['/tasks', '/runs', '/events'];
function isKnownRoute(_method: string, pathname: string): boolean {
  return KNOWN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

export { beaverPaths, type BeaverPaths } from './paths';

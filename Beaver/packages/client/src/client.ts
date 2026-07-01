import http from 'node:http';
import {
  BeaverError,
  isApiErrorBody,
  type BeaverConfig,
  type ExternalTask,
  type GitStatus,
  type HandoffResponse,
  type HealthResponse,
  type RepoValidation,
  type Run,
  type RunActionResponse,
  type RunEvent,
  type RunFileLocation,
  type RunFileReadResponse,
  type RunFilesResponse,
  type RunLogsResponse,
  type TaskClaimResponse,
  type TasksSyncResponse,
  type ToolAction
} from '@beaver/core';

type Method = 'GET' | 'POST';

const id = (value: string): string => encodeURIComponent(value);

/**
 * Presentation-free daemon client (D5): transport over the Unix domain socket +
 * contract decoding only. Typed data on 2xx, or `throw BeaverError` decoded from
 * the daemon's `ApiErrorBody`. No localization/rendering — that is the caller's
 * job. This is the single source of "how to call the daemon" for both the CLI
 * and (until Electrobun) the Electron main process.
 */
export class BeaverClient {
  constructor(private readonly socketPath: string) {}

  health(): Promise<HealthResponse> {
    return this.request('GET', '/health');
  }

  getConfig(): Promise<BeaverConfig> {
    return this.request('GET', '/config');
  }

  setConfig(config: BeaverConfig): Promise<BeaverConfig> {
    return this.request('POST', '/config', config);
  }

  validateRepo(repoPath: string): Promise<RepoValidation> {
    return this.request('POST', '/repo/validate', { repoPath });
  }

  listTasks(): Promise<ExternalTask[]> {
    return this.request('GET', '/tasks');
  }

  syncTasks(): Promise<TasksSyncResponse> {
    return this.request('POST', '/tasks/sync');
  }

  claimTask(taskId: string): Promise<TaskClaimResponse> {
    return this.request('POST', '/tasks/claim', { taskId });
  }

  listRuns(): Promise<Run[]> {
    return this.request('GET', '/runs');
  }

  startRun(taskId: string): Promise<Run> {
    return this.request('POST', '/runs/start', { taskId });
  }

  getRun(runId: string): Promise<Run> {
    return this.request('GET', `/runs/${id(runId)}`);
  }

  stopRun(runId: string): Promise<Run> {
    return this.request('POST', `/runs/${id(runId)}/stop`);
  }

  retryRun(runId: string): Promise<Run> {
    return this.request('POST', `/runs/${id(runId)}/retry`);
  }

  resumeRun(runId: string): Promise<Run> {
    return this.request('POST', `/runs/${id(runId)}/resume`);
  }

  runLogs(runId: string): Promise<RunLogsResponse> {
    return this.request('GET', `/runs/${id(runId)}/logs`);
  }

  runEvents(runId: string): Promise<RunEvent[]> {
    return this.request('GET', `/runs/${id(runId)}/events`);
  }

  runFiles(runId: string): Promise<RunFilesResponse> {
    return this.request('GET', `/runs/${id(runId)}/files`);
  }

  readRunFile(runId: string, fileName: string, location: RunFileLocation = 'runDir'): Promise<RunFileReadResponse> {
    return this.request('POST', `/runs/${id(runId)}/files/read`, { fileName, location });
  }

  runGitStatus(runId: string): Promise<GitStatus> {
    return this.request('GET', `/runs/${id(runId)}/git-status`);
  }

  runHandoff(runId: string): Promise<HandoffResponse> {
    return this.request('POST', `/runs/${id(runId)}/handoff`);
  }

  runAction(runId: string, action: ToolAction): Promise<RunActionResponse> {
    return this.request('POST', `/runs/${id(runId)}/actions`, { action });
  }

  private request<T>(method: Method, pathname: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: pathname,
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = text.length > 0 ? safeJson(text) : undefined;
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(parsed as T);
              return;
            }
            if (isApiErrorBody(parsed)) {
              reject(new BeaverError(parsed.error.code, parsed.error.params));
              return;
            }
            reject(new BeaverError('INTERNAL', { detail: text || `HTTP ${status}` }));
          });
        }
      );
      request.on('error', () => {
        reject(new BeaverError('DAEMON_UNAVAILABLE', { socket: this.socketPath }));
      });
      if (body !== undefined) {
        request.write(JSON.stringify(body));
      }
      request.end();
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

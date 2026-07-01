import type { BeaverConfig } from './config';
import type { ExternalTask, Run } from './domain';
import type { RunEvent } from './events';
import type { RunFileLocation, ToolAction } from './apiSchemas';

/**
 * The daemon HTTP API is the product contract. Electron IPC and the CLI are
 * both thin clients over this surface; neither may duplicate orchestration.
 *
 * Request bodies are validated by the zod schemas in `apiSchemas.ts` (the
 * single source for request shapes); this file owns the response shapes, the
 * value types they reference, and the endpoint catalog.
 */

export type HealthResponse = {
  ok: true;
  service: 'beaver-daemon';
  version: string;
};

export type RepoValidation = {
  repoPath: string;
  isGitWorktree: boolean;
  currentBranch?: string;
  message?: string;
};

export type TasksSyncResponse = { tasks: ExternalTask[] };
export type TaskClaimResponse = { claimed: boolean; runId?: string };

export type RunLogsResponse = {
  stdout: string;
  stderr: string;
  verifier: string;
};

export type RunFilesResponse = {
  runDir: string;
  worktreePath: string;
  runDirFiles: string[];
  worktreeFiles: string[];
};
export type RunFileReadResponse = { fileName: string; location: RunFileLocation; content: string };

export type GitFileStatus = { path: string; index: string; workingTree: string };
export type GitStatus = {
  branch?: string;
  clean: boolean;
  files: GitFileStatus[];
};

export type HandoffResponse = {
  summaryPath: string;
  diffPath: string;
};

export type RunActionResponse = {
  action: ToolAction;
  exitCode: number | null;
  outputPath?: string;
};

/**
 * Endpoint catalog, method + path template. Used for documentation and as the
 * checklist that every capability is CLI-reachable. `:id` is a run id.
 */
export const BEAVER_API_ROUTES = {
  health: { method: 'GET', path: '/health' },
  configGet: { method: 'GET', path: '/config' },
  configSet: { method: 'POST', path: '/config' },
  repoValidate: { method: 'POST', path: '/repo/validate' },
  tasksList: { method: 'GET', path: '/tasks' },
  tasksSync: { method: 'POST', path: '/tasks/sync' },
  tasksClaim: { method: 'POST', path: '/tasks/claim' },
  runsList: { method: 'GET', path: '/runs' },
  runsStart: { method: 'POST', path: '/runs/start' },
  runGet: { method: 'GET', path: '/runs/:id' },
  runStop: { method: 'POST', path: '/runs/:id/stop' },
  runRetry: { method: 'POST', path: '/runs/:id/retry' },
  runResume: { method: 'POST', path: '/runs/:id/resume' },
  runLogs: { method: 'GET', path: '/runs/:id/logs' },
  runEvents: { method: 'GET', path: '/runs/:id/events' },
  runFiles: { method: 'GET', path: '/runs/:id/files' },
  runFileRead: { method: 'POST', path: '/runs/:id/files/read' },
  runGitStatus: { method: 'GET', path: '/runs/:id/git-status' },
  runHandoff: { method: 'POST', path: '/runs/:id/handoff' },
  runActions: { method: 'POST', path: '/runs/:id/actions' },
  events: { method: 'GET', path: '/events' }
} as const;

export type BeaverApiRouteKey = keyof typeof BEAVER_API_ROUTES;

/** Response payload types keyed by endpoint, for typed client helpers. */
export type ApiResponses = {
  health: HealthResponse;
  configGet: BeaverConfig;
  configSet: BeaverConfig;
  repoValidate: RepoValidation;
  tasksList: ExternalTask[];
  tasksSync: TasksSyncResponse;
  tasksClaim: TaskClaimResponse;
  runsList: Run[];
  runsStart: Run;
  runGet: Run;
  runStop: Run;
  runRetry: Run;
  runResume: Run;
  runLogs: RunLogsResponse;
  runEvents: RunEvent[];
  runFiles: RunFilesResponse;
  runFileRead: RunFileReadResponse;
  runGitStatus: GitStatus;
  runHandoff: HandoffResponse;
  runActions: RunActionResponse;
};

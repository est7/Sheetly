/**
 * Beaver domain model.
 *
 * Two layers stay separate on purpose:
 *  - `ExternalTask` mirrors the upstream task source (Lark/Linear/GitHub/local).
 *    Its `businessStatus` is the upstream workflow; do not conflate it with
 *    runner execution state.
 *  - `Run` / `Attempt` are Beaver's own execution facts.
 *
 * All enum values below are the stable wire/persistence contract. They are
 * intentionally English and must not be localized. Clients localize by mapping
 * these values to i18n keys.
 */

export type TaskSourceType = 'larkBase' | 'localJson' | 'githubIssue' | 'linear';

/**
 * Local execution state machine vocabulary. This is the single source of truth
 * for run status; the legacy prototype `created/preparing_worktree/succeeded`
 * vocabulary is intentionally dropped.
 */
export type RunStatus =
  | 'discovered'
  | 'claimed'
  | 'preparing_workspace'
  | 'implementing'
  | 'verifying'
  | 'pr_ready'
  | 'done'
  | BlockReason
  | 'aborted';

/**
 * Block reasons trimmed to what the agent/verifier/workspace steps actually
 * classify today (D3). `blocked_requirement`/`blocked_scope`/
 * `blocked_max_attempts` (and the plan/review/fix states) are added with the
 * B8 fix loop.
 */
export type BlockReason =
  | 'blocked_permission'
  | 'blocked_agent_failed'
  | 'blocked_tests'
  | 'blocked_infra';

/**
 * Compact projection written back to the external task source. This is a
 * separate axis from `RunStatus`: the upstream Base only needs a coarse runner
 * signal, not the full internal state machine.
 */
export type RunnerStatus =
  | 'idle'
  | 'claimed'
  | 'running'
  | 'blocked'
  | 'pr_ready'
  | 'pr_opened'
  | 'done'
  | 'aborted';

export type AttemptPhase = 'implementing' | 'verifying';

export type ExternalTask = {
  id: string;
  sourceType: TaskSourceType;
  sourceProjectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  productDocUrl?: string;
  assignee?: string;
  /** Upstream business workflow status. Not the runner execution state. */
  businessStatus?: string;
  runnerStatus?: RunnerStatus;
  runnerOwner?: string;
  runnerRunId?: string;
  raw: Record<string, unknown>;
};

export type Claim = {
  runId: string;
  deviceId: string;
  claimedAt: string;
};

export type TaskUpdate = {
  runnerStatus?: RunnerStatus;
  runnerOwner?: string;
  runnerRunId?: string;
  runnerBranch?: string;
  runnerPrUrl?: string;
  runnerBlockReason?: BlockReason;
  runnerLastMessage?: string;
  runnerUpdatedAt: string;
};

export type Run = {
  id: string;
  taskId: string;
  status: RunStatus;
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  baseCommit?: string;
  attemptCount: number;
  currentPid?: number;
  heartbeatAt?: string;
  prUrl?: string;
  blockReason?: BlockReason;
  blockMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type Attempt = {
  id: string;
  runId: string;
  attemptNumber: number;
  phase: AttemptPhase;
  agentProfile?: string;
  command?: string;
  args?: string[];
  promptPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  transcriptPath?: string;
  diffPatchPath?: string;
  verifierOutputPath?: string;
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
};

export type Artifact = {
  id: string;
  runId: string;
  attemptId?: string;
  kind: string;
  path: string;
  createdAt: string;
};

export type Workspace = {
  runId: string;
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  taskPackDir: string;
};

export interface TaskSource {
  pollAssignedTasks(): Promise<ExternalTask[]>;
  claimTask(taskId: string, claim: Claim): Promise<boolean>;
  updateTask(taskId: string, update: TaskUpdate): Promise<void>;
}

/** Convenience sets for validation and exhaustive rendering. */
export const BLOCK_REASONS: readonly BlockReason[] = [
  'blocked_permission',
  'blocked_agent_failed',
  'blocked_tests',
  'blocked_infra'
];

export const RUN_STATUSES: readonly RunStatus[] = [
  'discovered',
  'claimed',
  'preparing_workspace',
  'implementing',
  'verifying',
  'pr_ready',
  'done',
  ...BLOCK_REASONS,
  'aborted'
];

export function isBlockReason(status: RunStatus): status is BlockReason {
  return (BLOCK_REASONS as readonly string[]).includes(status);
}

/** Statuses where a run is "in flight" — used for the active-run-per-task and concurrency guards. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'discovered',
  'claimed',
  'preparing_workspace',
  'implementing',
  'verifying',
  'pr_ready'
];

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

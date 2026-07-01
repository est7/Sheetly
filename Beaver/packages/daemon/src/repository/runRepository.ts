import { Database } from 'bun:sqlite';
import {
  BeaverError,
  assertRunTransition,
  type Artifact,
  type Attempt,
  type AttemptPhase,
  type ExternalTask,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunStatus
} from '@beaver/core';
import { CURRENT_SCHEMA_VERSION, runMigrations } from './migrations';

type Row = Record<string, unknown>;

export type AppendAttemptInput = {
  runId: string;
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
};

export type RegisterArtifactInput = {
  runId: string;
  attemptId?: string;
  kind: string;
  path: string;
};

/**
 * The sole SSOT for tasks/runs/attempts/events/artifacts (D6). It talks ONLY to
 * SQLite (bun:sqlite) — deliberately no `node:fs` import; the run-dir/events
 * mirror is written elsewhere and never read back here as truth. Constructed
 * from a db path alone.
 */
export class RunRepository {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  // ---- runs ----

  createRun(run: Run): void {
    this.db
      .query(
        `INSERT INTO runs (id, task_id, status, repo_path, worktree_path, branch_name, base_branch, base_commit,
          attempt_count, current_pid, heartbeat_at, pr_url, block_reason, block_message, created_at, updated_at, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        run.id,
        run.taskId,
        run.status,
        run.repoPath,
        run.worktreePath,
        run.branchName,
        run.baseBranch,
        run.baseCommit ?? null,
        run.attemptCount,
        run.currentPid ?? null,
        run.heartbeatAt ?? null,
        run.prUrl ?? null,
        run.blockReason ?? null,
        run.blockMessage ?? null,
        run.createdAt,
        run.updatedAt,
        run.startedAt ?? null,
        run.finishedAt ?? null
      );
  }

  getRun(id: string): Run | null {
    const row = this.db.query('SELECT * FROM runs WHERE id = ?').get(id) as Row | null;
    return row ? runFromRow(row) : null;
  }

  listRuns(): Run[] {
    return (this.db.query('SELECT * FROM runs ORDER BY created_at DESC').all() as Row[]).map(runFromRow);
  }

  updateRunStatus(id: string, to: RunStatus): Run {
    const current = this.getRun(id);
    if (!current) {
      throw new BeaverError('NOT_FOUND', { resource: 'run', id });
    }
    assertRunTransition(current.status, to);
    this.db.query('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(to, isoNow(), id);
    return this.getRun(id)!;
  }

  // ---- attempts (D7 append-only) ----

  appendAttempt(input: AppendAttemptInput): Attempt {
    const id = newId();
    const startedAt = isoNow();
    const insert = this.db.transaction(() => {
      const next = this.db
        .query('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM attempts WHERE run_id = ?')
        .get(input.runId) as { n: number };
      this.db
        .query(
          `INSERT INTO attempts (id, run_id, attempt_number, phase, agent_profile, command, args_json,
            prompt_path, stdout_path, stderr_path, transcript_path, diff_patch_path, verifier_output_path, started_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          input.runId,
          next.n,
          input.phase,
          input.agentProfile ?? null,
          input.command ?? null,
          input.args ? JSON.stringify(input.args) : null,
          input.promptPath ?? null,
          input.stdoutPath ?? null,
          input.stderrPath ?? null,
          input.transcriptPath ?? null,
          input.diffPatchPath ?? null,
          input.verifierOutputPath ?? null,
          startedAt
        );
      this.db.query('UPDATE runs SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?').run(isoNow(), input.runId);
    });
    insert();
    return this.getAttempt(id)!;
  }

  finalizeAttempt(id: string, result: { exitCode: number }): Attempt {
    const existing = this.getAttempt(id);
    if (!existing) {
      throw new BeaverError('NOT_FOUND', { resource: 'attempt', id });
    }
    if (existing.finishedAt) {
      throw new BeaverError('BAD_REQUEST', { detail: `attempt ${id} already finalized` });
    }
    this.db.query('UPDATE attempts SET exit_code = ?, finished_at = ? WHERE id = ?').run(result.exitCode, isoNow(), id);
    return this.getAttempt(id)!;
  }

  getAttempt(id: string): Attempt | null {
    const row = this.db.query('SELECT * FROM attempts WHERE id = ?').get(id) as Row | null;
    return row ? attemptFromRow(row) : null;
  }

  listAttempts(runId: string): Attempt[] {
    return (
      this.db.query('SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt_number ASC').all(runId) as Row[]
    ).map(attemptFromRow);
  }

  // ---- tasks ----

  upsertTasks(tasks: ExternalTask[]): void {
    const statement = this.db.query(
      `INSERT INTO tasks (id, source_type, source_project_id, title, description, acceptance_json, product_doc_url,
        assignee, business_status, runner_status, runner_owner, runner_run_id, raw_json, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         source_type = excluded.source_type, source_project_id = excluded.source_project_id, title = excluded.title,
         description = excluded.description, acceptance_json = excluded.acceptance_json, product_doc_url = excluded.product_doc_url,
         assignee = excluded.assignee, business_status = excluded.business_status, runner_status = excluded.runner_status,
         runner_owner = excluded.runner_owner, runner_run_id = excluded.runner_run_id, raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`
    );
    const now = isoNow();
    const upsert = this.db.transaction(() => {
      for (const task of tasks) {
        statement.run(
          task.id,
          task.sourceType,
          task.sourceProjectId,
          task.title,
          task.description,
          JSON.stringify(task.acceptanceCriteria),
          task.productDocUrl ?? null,
          task.assignee ?? null,
          task.businessStatus ?? null,
          task.runnerStatus ?? null,
          task.runnerOwner ?? null,
          task.runnerRunId ?? null,
          JSON.stringify(task.raw),
          now
        );
      }
    });
    upsert();
  }

  listTasks(sourceType?: string): ExternalTask[] {
    const rows = (
      sourceType
        ? this.db.query('SELECT * FROM tasks WHERE source_type = ? ORDER BY updated_at DESC').all(sourceType)
        : this.db.query('SELECT * FROM tasks ORDER BY updated_at DESC').all()
    ) as Row[];
    return rows.map(taskFromRow);
  }

  // ---- artifacts ----

  registerArtifact(input: RegisterArtifactInput): Artifact {
    const id = newId();
    const createdAt = isoNow();
    // FK constraint rejects an orphan (missing run) rather than storing a dangling row.
    this.db
      .query('INSERT INTO artifacts (id, run_id, attempt_id, kind, path, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, input.runId, input.attemptId ?? null, input.kind, input.path, createdAt);
    return { id, runId: input.runId, attemptId: input.attemptId, kind: input.kind, path: input.path, createdAt };
  }

  listArtifacts(runId: string): Artifact[] {
    return (
      this.db.query('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Row[]
    ).map(artifactFromRow);
  }

  // ---- events (append-only, monotonic seq — D19) ----

  appendEvent(input: { runId: string; type: RunEventType; payload: Record<string, unknown> }): RunEvent {
    const id = newId();
    const timestamp = isoNow();
    const row = this.db
      .query(
        `INSERT INTO events (id, run_id, type, timestamp, payload_json) VALUES (?, ?, ?, ?, ?) RETURNING seq`
      )
      .get(id, input.runId, input.type, timestamp, JSON.stringify(input.payload)) as { seq: number };
    return { id, runId: input.runId, type: input.type, timestamp, payload: input.payload, seq: Number(row.seq) };
  }

  readEventsSince(sinceSeq: number, runId?: string): RunEvent[] {
    const rows = (
      runId
        ? this.db
            .query('SELECT * FROM events WHERE seq > ? AND run_id = ? ORDER BY seq ASC')
            .all(sinceSeq, runId)
        : this.db.query('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC').all(sinceSeq)
    ) as Row[];
    return rows.map(eventFromRow);
  }
}

// ---- row mappers ----

function str(value: unknown): string {
  return value as string;
}
function optStr(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : (value as string);
}
function optNum(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function runFromRow(row: Row): Run {
  return {
    id: str(row.id),
    taskId: str(row.task_id),
    status: str(row.status) as RunStatus,
    repoPath: str(row.repo_path),
    worktreePath: str(row.worktree_path),
    branchName: str(row.branch_name),
    baseBranch: str(row.base_branch),
    baseCommit: optStr(row.base_commit),
    attemptCount: Number(row.attempt_count),
    currentPid: optNum(row.current_pid),
    heartbeatAt: optStr(row.heartbeat_at),
    prUrl: optStr(row.pr_url),
    blockReason: optStr(row.block_reason) as Run['blockReason'],
    blockMessage: optStr(row.block_message),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    startedAt: optStr(row.started_at),
    finishedAt: optStr(row.finished_at)
  };
}

function attemptFromRow(row: Row): Attempt {
  return {
    id: str(row.id),
    runId: str(row.run_id),
    attemptNumber: Number(row.attempt_number),
    phase: str(row.phase) as AttemptPhase,
    agentProfile: optStr(row.agent_profile),
    command: optStr(row.command),
    args: row.args_json ? (JSON.parse(str(row.args_json)) as string[]) : undefined,
    promptPath: optStr(row.prompt_path),
    stdoutPath: optStr(row.stdout_path),
    stderrPath: optStr(row.stderr_path),
    transcriptPath: optStr(row.transcript_path),
    diffPatchPath: optStr(row.diff_patch_path),
    verifierOutputPath: optStr(row.verifier_output_path),
    exitCode: optNum(row.exit_code),
    startedAt: str(row.started_at),
    finishedAt: optStr(row.finished_at)
  };
}

function taskFromRow(row: Row): ExternalTask {
  return {
    id: str(row.id),
    sourceType: str(row.source_type) as ExternalTask['sourceType'],
    sourceProjectId: str(row.source_project_id),
    title: str(row.title),
    description: str(row.description),
    acceptanceCriteria: JSON.parse(str(row.acceptance_json)) as string[],
    productDocUrl: optStr(row.product_doc_url),
    assignee: optStr(row.assignee),
    businessStatus: optStr(row.business_status),
    runnerStatus: optStr(row.runner_status) as ExternalTask['runnerStatus'],
    runnerOwner: optStr(row.runner_owner),
    runnerRunId: optStr(row.runner_run_id),
    raw: JSON.parse(str(row.raw_json)) as Record<string, unknown>
  };
}

function eventFromRow(row: Row): RunEvent {
  return {
    id: str(row.id),
    runId: str(row.run_id),
    type: str(row.type) as RunEventType,
    timestamp: str(row.timestamp),
    payload: JSON.parse(str(row.payload_json)) as Record<string, unknown>,
    seq: Number(row.seq)
  };
}

function artifactFromRow(row: Row): Artifact {
  return {
    id: str(row.id),
    runId: str(row.run_id),
    attemptId: optStr(row.attempt_id),
    kind: str(row.kind),
    path: str(row.path),
    createdAt: str(row.created_at)
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

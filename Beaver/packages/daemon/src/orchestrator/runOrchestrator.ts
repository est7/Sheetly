import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  BeaverError,
  isActiveRunStatus,
  type AgentProfile,
  type BeaverConfig,
  type BlockReason,
  type ExternalTask,
  type Run,
  type RunStatus,
  type TemplateVariables
} from '@beaver/core';
import { AgentRunner, createBackend, type AgentBackendHandle, type AgentMessage } from '../agent';
import { EventLog } from '../eventLog';
import { HandoffBuilder } from '../handoff';
import { RunRepository } from '../repository/runRepository';
import { TaskPackBuilder } from '../taskPack';
import { VerifierRunner } from '../verifier';
import { WorkspaceManager } from '../workspace';

/** Blocked states a run can be session-resumed from (each has a prepared
 * worktree and can re-enter `implementing` per the state machine). */
const RESUMABLE_STATUSES: readonly RunStatus[] = ['blocked_infra', 'blocked_agent_failed', 'blocked_tests'];

export type OrchestratorDeps = {
  repo: RunRepository;
  eventLog: EventLog;
  workspace: WorkspaceManager;
  taskPack: TaskPackBuilder;
  agentRunner: AgentRunner;
  verifier: VerifierRunner;
  handoff: HandoffBuilder;
  /** Resolved `<home>/runs`. */
  runsDir: string;
  /** Resolved worktree root. */
  workspaceRoot: string;
};

/**
 * State-machine-only coordinator (no daemon routes here — that is SC11). It
 * enforces the concurrency + active-run-per-task guards, then drives one run
 * through the trimmed state machine, delegating side effects to the workspace /
 * task-pack / agent / verifier / handoff services and recording every step as
 * a persisted status + append-only event. A real failure at any step becomes an
 * explicit blocked_* status — never a faked success.
 */
export class RunOrchestrator {
  private readonly agentHandles = new Map<string, AgentBackendHandle>();
  private readonly canceled = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Crash recovery (B8): a daemon restart orphans any run left in an active
   * state — the agent process died with the old daemon, or is an unmanaged
   * orphan we can no longer re-attach to. Move each to `aborted` (the universal
   * terminal, legal from every active state) and record why in the event log;
   * the run can be retried (a fresh run) from there. No process signalling: a
   * recycled pid makes killing by the stored pid unsafe. Returns the runs it
   * reconciled. Call once at startup, before the socket accepts clients.
   */
  async recoverInterruptedRuns(): Promise<Run[]> {
    const recovered: Run[] = [];
    for (const run of this.deps.repo.listActiveRuns()) {
      // A run that got past workspace prep has a worktree + baseCommit, so it can
      // be session-resumed → blocked_infra. One that didn't (discovered/claimed/
      // preparing) has nothing to resume → aborted (retry starts fresh).
      const resumable = Boolean(run.baseCommit);
      const to = resumable ? 'blocked_infra' : 'aborted';
      const message = `interrupted by daemon restart${run.currentPid ? ` (was pid ${run.currentPid})` : ''}${resumable ? '; resume to continue' : ''}`;
      this.deps.repo.updateRunStatus(run.id, to);
      this.deps.repo.patchRun(
        run.id,
        resumable
          ? { currentPid: undefined, blockReason: 'blocked_infra', blockMessage: message }
          : { currentPid: undefined, finishedAt: new Date().toISOString() }
      );
      await this.deps.eventLog.append(run.id, 'run.status_changed', { from: run.status, to, message });
      const reconciled = this.deps.repo.getRun(run.id);
      if (reconciled) {
        recovered.push(reconciled);
      }
    }
    return recovered;
  }

  /**
   * Resume a blocked run: re-run the agent with its prior session id (continuing
   * the conversation) in the already-prepared worktree, then verify + handoff.
   * Synchronous guard + transition; execution runs in the background like start.
   */
  resumeRun(runId: string, config: BeaverConfig, tasks: ExternalTask[]): Run {
    const run = this.deps.repo.getRun(runId);
    if (!run) {
      throw new BeaverError('NOT_FOUND', { resource: 'run', id: runId });
    }
    if (isActiveRunStatus(run.status)) {
      throw new BeaverError('RUN_BLOCKED', { reason: `run ${runId} is still active` });
    }
    if (!RESUMABLE_STATUSES.includes(run.status)) {
      throw new BeaverError('RUN_BLOCKED', { reason: `run ${runId} (${run.status}) is not resumable` });
    }
    if (!run.baseCommit) {
      throw new BeaverError('RUN_BLOCKED', { reason: `run ${runId} has no prepared worktree to resume` });
    }
    const task = tasks.find((t) => t.id === run.taskId);
    if (!task) {
      throw new BeaverError('NOT_FOUND', { resource: 'task', id: run.taskId });
    }
    // Resuming makes the run active again — honour the same guards as startRun:
    // one active run per task (D20) and the concurrency ceiling.
    const active = this.deps.repo.listActiveRuns();
    if (active.some((r) => r.taskId === run.taskId)) {
      throw new BeaverError('RUN_BLOCKED', { reason: `task ${run.taskId} already has an active run` });
    }
    if (active.length >= config.maxConcurrentRuns) {
      throw new BeaverError('RUN_BLOCKED', { reason: `max concurrent runs reached (${config.maxConcurrentRuns})` });
    }
    this.canceled.delete(runId);
    // Reactivating a terminal/blocked run: clear the block + finish metadata so a
    // resumed run that reaches pr_ready is not simultaneously "ready" and "blocked".
    this.deps.repo.patchRun(runId, { blockReason: undefined, blockMessage: undefined, finishedAt: undefined });
    const promptPath = path.join(run.worktreePath, '.runs', run.id, 'task.md');
    void this.implementVerifyHandoff(run, task, config, {
      promptPath,
      resumeSessionId: this.lastSessionId(runId),
      resumed: true
    }).catch((error) => this.blockOnError(run.id, error));
    return this.deps.repo.getRun(runId)!;
  }

  /** The most recent attempt's pinned session id, if any. */
  private lastSessionId(runId: string): string | undefined {
    const attempts = this.deps.repo.listAttempts(runId);
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const sessionId = attempts[i]?.sessionId;
      if (sessionId) {
        return sessionId;
      }
    }
    return undefined;
  }

  /** Stop an active run: signal a running agent's process group, else abort it directly. */
  async stopRun(runId: string): Promise<Run> {
    const run = this.deps.repo.getRun(runId);
    if (!run) {
      throw new BeaverError('NOT_FOUND', { resource: 'run', id: runId });
    }
    if (!isActiveRunStatus(run.status)) {
      throw new BeaverError('RUN_BLOCKED', { reason: `run ${runId} is not active` });
    }
    this.canceled.add(runId);
    const handle = this.agentHandles.get(runId);
    if (handle) {
      handle.stop(); // execute() observes 'stopped' and transitions to aborted
    }
    return this.deps.repo.getRun(runId)!;
  }

  /** Retry = a brand-new run for the same task (D7); the prior run stays immutable. */
  retryRun(runId: string, config: BeaverConfig, tasks: ExternalTask[]): Run {
    const run = this.deps.repo.getRun(runId);
    if (!run) {
      throw new BeaverError('NOT_FOUND', { resource: 'run', id: runId });
    }
    if (isActiveRunStatus(run.status)) {
      throw new BeaverError('RUN_BLOCKED', { reason: `run ${runId} is still active` });
    }
    return this.startRun(run.taskId, config, tasks);
  }

  /** Synchronous guard + create; execution runs in the background. */
  startRun(taskId: string, config: BeaverConfig, tasks: ExternalTask[]): Run {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new BeaverError('NOT_FOUND', { resource: 'task', id: taskId });
    }
    // Atomic in the single daemon: no await between the active-run read and createRun.
    const active = this.deps.repo.listActiveRuns();
    if (active.some((run) => run.taskId === taskId)) {
      throw new BeaverError('RUN_BLOCKED', { reason: `task ${taskId} already has an active run` });
    }
    if (active.length >= config.maxConcurrentRuns) {
      throw new BeaverError('RUN_BLOCKED', { reason: `max concurrent runs reached (${config.maxConcurrentRuns})` });
    }
    const run = this.buildRun(task, config);
    this.deps.repo.createRun(run);
    void this.deps.eventLog.append(run.id, 'run.created', { taskId }).catch(() => undefined);
    void this.execute(run, task, config).catch(() => undefined);
    return run;
  }

  agentHandle(runId: string): AgentBackendHandle | undefined {
    return this.agentHandles.get(runId);
  }

  private buildRun(task: ExternalTask, config: BeaverConfig): Run {
    const runId = crypto.randomUUID();
    const slug = `${sanitizeSegment(task.id)}-${runId.slice(0, 8)}`;
    const now = new Date().toISOString();
    return {
      id: runId,
      taskId: task.id,
      status: 'discovered',
      repoPath: rawString(task.raw.repoPath) || config.defaultRepoPath,
      worktreePath: path.join(this.deps.workspaceRoot, slug),
      branchName: `beaver/${slug}`,
      baseBranch: rawString(task.raw.baseBranch) || 'main',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private async execute(run: Run, task: ExternalTask, config: BeaverConfig): Promise<void> {
    const submodules = rawStringArray(task.raw.requiredSubmodules);
    try {
      await this.transition(run.id, 'claimed');
      await this.transition(run.id, 'preparing_workspace');
      if (this.canceled.has(run.id)) {
        await this.finishAbort(run.id);
        return;
      }

      const { baseCommit } = await this.deps.workspace.prepare({
        repoPath: run.repoPath,
        worktreePath: run.worktreePath,
        branchName: run.branchName,
        baseBranch: run.baseBranch,
        requiredSubmodules: submodules,
        submoduleUpdate: config.submoduleUpdate
      });
      this.deps.repo.patchRun(run.id, { baseCommit });
      await this.deps.eventLog.append(run.id, 'worktree.created', { worktreePath: run.worktreePath, baseCommit });

      const pack = await this.deps.taskPack.materialize({
        runId: run.id,
        worktreePath: run.worktreePath,
        runsDir: this.deps.runsDir,
        task: { id: task.id, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria },
        constraints: { repoPath: run.repoPath, baseBranch: run.baseBranch, requiredSubmodules: submodules },
        commands: config.verifier ? [`${config.verifier.command} ${config.verifier.args.join(' ')}`] : []
      });
      for (const artifact of pack.artifacts) {
        this.deps.repo.registerArtifact({ runId: run.id, kind: artifact.kind, path: artifact.path });
      }
      await this.deps.eventLog.append(run.id, 'files.materialized', { packDir: pack.packDir });

      if (this.canceled.has(run.id)) {
        await this.finishAbort(run.id);
        return;
      }
      await this.implementVerifyHandoff(run, task, config, {
        baseCommit,
        promptPath: path.join(pack.packDir, 'task.md')
      });
    } catch (error) {
      this.agentHandles.delete(run.id);
      await this.blockOnError(run.id, error);
    }
  }

  /**
   * Implement → verify → handoff. Shared by a fresh run (after workspace prep)
   * and resume (reusing the prepared worktree + task pack). `resumeSessionId`
   * continues the agent's prior session; a stop/failure/verify-fail lands on the
   * matching terminal/blocked state — never a faked success.
   */
  private async implementVerifyHandoff(
    run: Run,
    task: ExternalTask,
    config: BeaverConfig,
    opts: { baseCommit?: string; promptPath: string; resumeSessionId?: string; resumed?: boolean }
  ): Promise<void> {
    const runDir = path.join(this.deps.runsDir, run.id);
    const stdoutPath = path.join(runDir, 'stdout.log');
    const stderrPath = path.join(runDir, 'stderr.log');
    const profile = this.resolveProfile(task, config);
    const variables: TemplateVariables = {
      taskId: task.id,
      runId: run.id,
      runDir,
      repoPath: run.repoPath,
      worktreePath: run.worktreePath,
      branchName: run.branchName
    };

    const packDir = path.dirname(opts.promptPath);
    let promptPath = opts.promptPath;
    let resumeSessionId = opts.resumeSessionId;
    let resumed = opts.resumed ?? false;
    let fixesLeft = config.maxFixAttempts;

    // implement → verify, looping while the verifier fails and fix attempts
    // remain (B8 fix loop). Each fix cycle re-runs the agent in the same session
    // with the verifier output, going verifying → blocked_tests → implementing.
    for (let cycle = 0; ; cycle += 1) {
      await this.transition(run.id, 'implementing');
      const attempt = this.deps.repo.appendAttempt({
        runId: run.id,
        phase: 'implementing',
        agentProfile: profile.name,
        command: profile.command,
        args: profile.args,
        promptPath,
        stdoutPath,
        stderrPath
      });
      await this.deps.eventLog.append(run.id, 'agent.started', {
        command: profile.command,
        provider: profile.provider ?? null,
        resumed
      });
      const promptText = await readFile(promptPath, 'utf8');
      const backend = createBackend(profile, this.deps.agentRunner);
      let sessionPinned = false;
      const handle = backend.run(
        {
          cwd: run.worktreePath,
          promptText,
          promptPath,
          stdoutPath,
          stderrPath,
          blockingExitCodes: profile.blockingExitCodes,
          // For a provider, profile args are extra CLI flags; the generic
          // backend already owns them via its constructor.
          extraArgs: profile.provider ? profile.args : undefined,
          resumeSessionId,
          variables
        },
        (message) => {
          // Pin the session id the instant the backend emits it (claude/codex
          // status frames), so a crash mid-run keeps resume provenance.
          if (!sessionPinned && message.sessionId) {
            sessionPinned = true;
            this.deps.repo.setAttemptSession(attempt.id, message.sessionId);
          }
          this.emitAgentMessage(run.id, message);
        }
      );
      this.agentHandles.set(run.id, handle);
      this.deps.repo.patchRun(run.id, { currentPid: handle.pid });
      // A stop that raced the spawn (canceled set while no handle existed) is
      // honored here rather than letting the agent run to completion.
      if (this.canceled.has(run.id)) {
        handle.stop();
      }
      const agentResult = await handle.result;
      this.agentHandles.delete(run.id);
      this.deps.repo.finalizeAttempt(attempt.id, { exitCode: agentResult.exitCode ?? -1, sessionId: agentResult.sessionId });
      this.deps.repo.patchRun(run.id, { currentPid: undefined });
      await this.deps.eventLog.append(run.id, 'agent.exited', {
        status: agentResult.status,
        exitCode: agentResult.exitCode
      });

      if (agentResult.status === 'stopped') {
        await this.transition(run.id, 'aborted');
        return;
      }
      if (agentResult.status !== 'completed') {
        await this.block(
          run.id,
          'blocked_agent_failed',
          `agent ${agentResult.status}${agentResult.error ? `: ${agentResult.error}` : ` (exit ${agentResult.exitCode})`}`
        );
        return;
      }
      if (this.canceled.has(run.id)) {
        await this.finishAbort(run.id);
        return;
      }

      await this.transition(run.id, 'verifying');
      if (!config.verifier) {
        break; // no verifier configured → nothing to fix, proceed to handoff
      }
      await this.deps.eventLog.append(run.id, 'verifier.started', {});
      const verify = await this.deps.verifier.run(config.verifier, {
        cwd: run.worktreePath,
        verifierLogPath: path.join(runDir, 'verifier.log'),
        variables
      });
      await this.deps.eventLog.append(run.id, 'verifier.exited', { status: verify.status, exitCode: verify.exitCode });
      if (verify.status === 'passed') {
        break;
      }

      // Verifier failed: auto-fix while attempts remain, else block (no fake success).
      const reason = `verifier ${verify.status} (exit ${verify.exitCode})`;
      if (fixesLeft <= 0) {
        await this.block(run.id, 'blocked_tests', reason);
        return;
      }
      if (this.canceled.has(run.id)) {
        await this.finishAbort(run.id);
        return;
      }
      fixesLeft -= 1;
      // Non-terminal: blocked_tests loops back to implementing (a fix cycle).
      await this.transition(run.id, 'blocked_tests');
      await this.deps.eventLog.append(run.id, 'run.error', {
        message: `${reason}; auto-fixing (${fixesLeft} attempt(s) left)`
      });
      promptPath = await this.writeFixPrompt(packDir, path.join(runDir, 'verifier.log'), cycle + 1);
      resumeSessionId = agentResult.sessionId ?? resumeSessionId; // continue the same session
      resumed = true;
    }

    if (this.canceled.has(run.id)) {
      await this.finishAbort(run.id);
      return;
    }
    // Build the handoff and emit its event BEFORE flipping to pr_ready, so a
    // client that observes pr_ready is guaranteed the handoff artifacts +
    // event already exist (no race).
    const handoff = await this.deps.handoff.build({
      gitBinary: config.gitBinary,
      worktreePath: run.worktreePath,
      runDir,
      runId: run.id,
      branchName: run.branchName,
      baseCommit: opts.baseCommit ?? run.baseCommit ?? ''
    });
    this.deps.repo.registerArtifact({ runId: run.id, kind: 'handoff:summary.md', path: handoff.summaryPath });
    this.deps.repo.registerArtifact({ runId: run.id, kind: 'handoff:diff.patch', path: handoff.diffPath });
    await this.deps.eventLog.append(run.id, 'handoff.created', handoff);
    await this.transition(run.id, 'pr_ready');
  }

  /** Write the fix-loop prompt for the next attempt: the failing verifier's
   * output tail, so the (session-continuing) agent knows what to fix. */
  private async writeFixPrompt(packDir: string, verifierLogPath: string, index: number): Promise<string> {
    let log = '';
    try {
      log = (await readFile(verifierLogPath, 'utf8')).slice(-4000);
    } catch {
      log = '(verifier produced no captured output)';
    }
    const fixPath = path.join(packDir, `fix-${index}.md`);
    const body = `# Fix attempt ${index}\n\nThe verifier failed. Fix the code in this worktree so the verifier passes, then stop.\n\nVerifier output (tail):\n\n\`\`\`\n${log}\n\`\`\`\n`;
    await writeFile(fixPath, body, 'utf8');
    return fixPath;
  }

  /** Fan a normalized agent message into the append-only event log. The raw
   * bytes are already persisted to the stdout/stderr log files by the runner;
   * these events carry the structured stream for clients. */
  private emitAgentMessage(runId: string, message: AgentMessage): void {
    switch (message.type) {
      case 'text':
        void this.deps.eventLog.append(runId, 'agent.text', { content: message.content });
        break;
      case 'thinking':
        void this.deps.eventLog.append(runId, 'agent.thinking', { content: message.content });
        break;
      case 'tool_use':
        void this.deps.eventLog.append(runId, 'agent.tool_use', {
          tool: message.tool,
          callId: message.callId,
          input: message.input
        });
        break;
      case 'tool_result':
        void this.deps.eventLog.append(runId, 'agent.tool_result', {
          tool: message.tool,
          callId: message.callId,
          output: message.output
        });
        break;
      case 'error':
        void this.deps.eventLog.append(runId, 'agent.stderr', { line: message.content });
        break;
      case 'log':
        void this.deps.eventLog.append(runId, 'agent.stderr', { line: message.content });
        break;
      case 'status':
        // Lifecycle marker; the run status axis already tracks this.
        break;
    }
  }

  private resolveProfile(task: ExternalTask, config: BeaverConfig): AgentProfile & { name: string } {
    const name = rawString(task.raw.agentProfile) || config.defaultAgentProfile;
    const profile = config.agentProfiles[name];
    if (!profile) {
      throw new BeaverError('CONFIG_INVALID', { detail: `agent profile "${name}" is not defined` });
    }
    return { ...profile, name };
  }

  private async transition(runId: string, to: RunStatus): Promise<void> {
    const current = this.deps.repo.getRun(runId)?.status;
    this.deps.repo.updateRunStatus(runId, to);
    await this.deps.eventLog.append(runId, 'run.status_changed', { from: current, to });
  }

  private async block(runId: string, reason: BlockReason, message: string): Promise<void> {
    const current = this.deps.repo.getRun(runId)?.status;
    this.deps.repo.updateRunStatus(runId, reason);
    this.deps.repo.patchRun(runId, { blockReason: reason, blockMessage: message, finishedAt: new Date().toISOString() });
    await this.deps.eventLog.append(runId, 'run.status_changed', { from: current, to: reason, message });
  }

  private async finishAbort(runId: string): Promise<void> {
    const current = this.deps.repo.getRun(runId)?.status;
    if (current && current !== 'aborted') {
      this.deps.repo.updateRunStatus(runId, 'aborted');
      this.deps.repo.patchRun(runId, { finishedAt: new Date().toISOString() });
      await this.deps.eventLog.append(runId, 'run.status_changed', { from: current, to: 'aborted' });
    }
  }

  private async blockOnError(runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.block(runId, 'blocked_infra', message);
    } catch {
      // The current status may not permit blocked_infra; record the error event regardless.
      await this.deps.eventLog.append(runId, 'run.error', { message }).catch(() => undefined);
    }
  }
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return cleaned.length > 0 ? cleaned : 'task';
}

function rawString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rawStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

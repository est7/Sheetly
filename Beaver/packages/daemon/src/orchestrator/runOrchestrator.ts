import path from 'node:path';
import {
  BeaverError,
  type AgentProfile,
  type BeaverConfig,
  type BlockReason,
  type ExternalTask,
  type Run,
  type RunStatus,
  type TemplateVariables
} from '@beaver/core';
import { AgentRunner, type AgentRunHandle } from '../agent';
import { EventLog } from '../eventLog';
import { HandoffBuilder } from '../handoff';
import { RunRepository } from '../repository/runRepository';
import { TaskPackBuilder } from '../taskPack';
import { VerifierRunner } from '../verifier';
import { WorkspaceManager } from '../workspace';

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
  private readonly agentHandles = new Map<string, AgentRunHandle>();

  constructor(private readonly deps: OrchestratorDeps) {}

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
    void this.deps.eventLog.append(run.id, 'run.created', { taskId });
    void this.execute(run, task, config).catch(() => undefined);
    return run;
  }

  agentHandle(runId: string): AgentRunHandle | undefined {
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
    const runDir = path.join(this.deps.runsDir, run.id);
    const stdoutPath = path.join(runDir, 'stdout.log');
    const stderrPath = path.join(runDir, 'stderr.log');
    const submodules = rawStringArray(task.raw.requiredSubmodules);
    try {
      await this.transition(run.id, 'claimed');
      await this.transition(run.id, 'preparing_workspace');

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

      const profile = this.resolveProfile(task, config);
      const variables: TemplateVariables = {
        taskId: task.id,
        runId: run.id,
        runDir,
        repoPath: run.repoPath,
        worktreePath: run.worktreePath,
        branchName: run.branchName
      };

      await this.transition(run.id, 'implementing');
      const attempt = this.deps.repo.appendAttempt({
        runId: run.id,
        phase: 'implementing',
        agentProfile: profile.name,
        command: profile.command,
        args: profile.args,
        promptPath: path.join(pack.packDir, 'task.md'),
        stdoutPath,
        stderrPath
      });
      await this.deps.eventLog.append(run.id, 'agent.started', { command: profile.command });
      const handle = this.deps.agentRunner.run({
        command: profile.command,
        args: profile.args,
        cwd: run.worktreePath,
        stdoutPath,
        stderrPath,
        blockingExitCodes: profile.blockingExitCodes,
        variables,
        onStdout: (line) => void this.deps.eventLog.append(run.id, 'agent.stdout', { line }),
        onStderr: (line) => void this.deps.eventLog.append(run.id, 'agent.stderr', { line })
      });
      this.agentHandles.set(run.id, handle);
      this.deps.repo.patchRun(run.id, { currentPid: handle.pid });
      const agentResult = await handle.result;
      this.agentHandles.delete(run.id);
      this.deps.repo.finalizeAttempt(attempt.id, { exitCode: agentResult.exitCode ?? -1 });
      this.deps.repo.patchRun(run.id, { currentPid: undefined });
      await this.deps.eventLog.append(run.id, 'agent.exited', { status: agentResult.status, exitCode: agentResult.exitCode });

      if (agentResult.status === 'stopped') {
        await this.transition(run.id, 'aborted');
        return;
      }
      if (agentResult.status !== 'succeeded') {
        await this.block(run.id, 'blocked_agent_failed', `agent ${agentResult.status} (exit ${agentResult.exitCode})`);
        return;
      }

      await this.transition(run.id, 'verifying');
      if (config.verifier) {
        await this.deps.eventLog.append(run.id, 'verifier.started', {});
        const verify = await this.deps.verifier.run(config.verifier, {
          cwd: run.worktreePath,
          verifierLogPath: path.join(runDir, 'verifier.log'),
          variables
        });
        await this.deps.eventLog.append(run.id, 'verifier.exited', { status: verify.status, exitCode: verify.exitCode });
        if (verify.status !== 'passed') {
          await this.block(run.id, 'blocked_tests', `verifier ${verify.status} (exit ${verify.exitCode})`);
          return;
        }
      }

      await this.transition(run.id, 'pr_ready');
      const handoff = await this.deps.handoff.build({
        gitBinary: config.gitBinary,
        worktreePath: run.worktreePath,
        runDir,
        runId: run.id,
        branchName: run.branchName,
        baseCommit
      });
      this.deps.repo.registerArtifact({ runId: run.id, kind: 'handoff:summary.md', path: handoff.summaryPath });
      this.deps.repo.registerArtifact({ runId: run.id, kind: 'handoff:diff.patch', path: handoff.diffPath });
      await this.deps.eventLog.append(run.id, 'handoff.created', handoff);
    } catch (error) {
      this.agentHandles.delete(run.id);
      await this.blockOnError(run.id, error);
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

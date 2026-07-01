import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BeaverConfigSchema, beaverPaths, type BeaverConfig, type ExternalTask, type Run } from '@beaver/core';
import { RunRepository } from '../src/repository/runRepository';
import { EventLog } from '../src/eventLog';
import { WorkspaceManager } from '../src/workspace';
import { TaskPackBuilder } from '../src/taskPack';
import { AgentRunner } from '../src/agent';
import { VerifierRunner } from '../src/verifier';
import { HandoffBuilder } from '../src/handoff';
import { RunOrchestrator } from '../src/orchestrator';

let home: string;
let repoPath: string;
let repo: RunRepository;
let orch: RunOrchestrator;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function config(overrides: Record<string, unknown> = {}): BeaverConfig {
  return BeaverConfigSchema.parse({
    defaultAgentProfile: 'generic',
    agentProfiles: { generic: { command: 'bash', args: ['-lc', 'echo change >> README.md'] } },
    verifier: { command: 'bash', args: ['-lc', 'exit 0'], blockingExitCodes: [] },
    maxConcurrentRuns: 2,
    ...overrides
  });
}

function task(id: string): ExternalTask {
  return {
    id,
    sourceType: 'localJson',
    sourceProjectId: 'proj',
    title: 'Do it',
    description: 'desc',
    acceptanceCriteria: ['works'],
    raw: { repoPath, baseBranch: 'main', agentProfile: 'generic', requiredSubmodules: [] }
  };
}

function activeRun(id: string, taskId: string): Run {
  const now = '2026-06-30T00:00:00.000Z';
  return {
    id,
    taskId,
    status: 'implementing',
    repoPath,
    worktreePath: `/wt/${id}`,
    branchName: `beaver/${id}`,
    baseBranch: 'main',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

beforeEach(async () => {
  home = path.join('/tmp', `bv-orch-${randomUUID().slice(0, 8)}`);
  repoPath = path.join(home, 'repo');
  await fs.mkdir(repoPath, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'ignore' });
  git(repoPath, 'config', 'user.email', 't@example.com');
  git(repoPath, 'config', 'user.name', 'Beaver Test');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'init');

  const paths = beaverPaths({ BEAVER_HOME: home });
  repo = new RunRepository(paths.dbPath);
  orch = new RunOrchestrator({
    repo,
    eventLog: new EventLog(repo, paths.runsDir),
    workspace: new WorkspaceManager('git'),
    taskPack: new TaskPackBuilder(),
    agentRunner: new AgentRunner(50),
    verifier: new VerifierRunner(),
    handoff: new HandoffBuilder(),
    runsDir: paths.runsDir,
    workspaceRoot: path.join(home, 'workspaces')
  });
});

afterEach(async () => {
  repo.close();
  await fs.rm(home, { recursive: true, force: true });
});

async function waitForTerminal(runId: string): Promise<Run> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = repo.getRun(runId)!;
    if (['pr_ready', 'done', 'aborted'].includes(run.status) || run.status.startsWith('blocked_')) {
      return run;
    }
    await delay(30);
  }
  return repo.getRun(runId)!;
}

describe('RunOrchestrator happy path', () => {
  test('drives a run discovered -> pr_ready, delegating to every service', async () => {
    const started = orch.startRun('task-1', config(), [task('task-1')]);
    expect(started.status).toBe('discovered');
    const run = await waitForTerminal(started.id);
    expect(run.status).toBe('pr_ready');
    expect(run.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    // handoff + task pack artifacts recorded and on disk
    expect(existsSync(path.join(home, 'runs', run.id, 'summary.md'))).toBe(true);
    expect(repo.listArtifacts(run.id).some((a) => a.kind === 'handoff:summary.md')).toBe(true);
    // agent ran inside the worktree (README modified there)
    expect((await fs.readFile(path.join(run.worktreePath, 'README.md'), 'utf8'))).toContain('change');
    // an implementing attempt was recorded and finalized
    const attempts = repo.listAttempts(run.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.exitCode).toBe(0);
    // events captured
    const types = repo.readEventsSince(0, run.id).map((e) => e.type);
    expect(types).toContain('worktree.created');
    expect(types).toContain('agent.exited');
    expect(types).toContain('handoff.created');
  });

  test('blocks the run when the verifier fails (no faked success)', async () => {
    const cfg = config({ verifier: { command: 'bash', args: ['-lc', 'exit 1'], blockingExitCodes: [] } });
    const started = orch.startRun('task-2', cfg, [task('task-2')]);
    const run = await waitForTerminal(started.id);
    expect(run.status).toBe('blocked_tests');
    expect(run.blockReason).toBe('blocked_tests');
  });
});

async function waitForStatus(runId: string, statuses: string[]): Promise<Run> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = repo.getRun(runId)!;
    if (statuses.includes(run.status)) {
      return run;
    }
    await delay(20);
  }
  return repo.getRun(runId)!;
}

describe('RunOrchestrator run-control', () => {
  test('stopRun aborts an active run and kills the agent process group', async () => {
    const cfg = config({ agentProfiles: { generic: { command: 'bash', args: ['-lc', 'sleep 300'] } } });
    const started = orch.startRun('task-1', cfg, [task('task-1')]);
    await waitForStatus(started.id, ['implementing']);
    await orch.stopRun(started.id);
    const run = await waitForStatus(started.id, ['aborted']);
    expect(run.status).toBe('aborted');
    await delay(100);
    let leaked: string[] = [];
    try {
      leaked = execFileSync('pgrep', ['-f', 'sleep 300'], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      leaked = []; // pgrep exits 1 when nothing matches
    }
    expect(leaked).toHaveLength(0);
  });

  test('stopRun requested during verifying still ends aborted, never pr_ready', async () => {
    const cfg = config({ verifier: { command: 'bash', args: ['-lc', 'sleep 1'], blockingExitCodes: [] } });
    const started = orch.startRun('task-1', cfg, [task('task-1')]);
    await waitForStatus(started.id, ['verifying']);
    await orch.stopRun(started.id);
    const run = await waitForStatus(started.id, ['aborted', 'pr_ready']);
    expect(run.status).toBe('aborted');
  });

  test('retryRun starts a fresh run for the same task (prior run untouched)', async () => {
    const old: Run = { ...activeRun('run-old', 'task-1'), status: 'blocked_tests' };
    repo.createRun(old);
    const fresh = orch.retryRun('run-old', config(), [task('task-1')]);
    expect(fresh.id).not.toBe('run-old');
    expect(fresh.taskId).toBe('task-1');
    expect(fresh.status).toBe('discovered');
    expect(repo.getRun('run-old')!.status).toBe('blocked_tests');
    await waitForTerminal(fresh.id);
  });
});

describe('RunOrchestrator guards', () => {
  test('rejects a second active run for the same task (D20)', () => {
    repo.createRun(activeRun('run-existing', 'task-1'));
    expect(() => orch.startRun('task-1', config(), [task('task-1')])).toThrow(/active run/);
  });

  test('rejects starting beyond maxConcurrentRuns (D18)', () => {
    repo.createRun(activeRun('run-a', 'task-a'));
    repo.createRun(activeRun('run-b', 'task-b'));
    try {
      orch.startRun('task-2', config({ maxConcurrentRuns: 2 }), [task('task-2')]);
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('RUN_BLOCKED');
    }
  });
});

describe('RunOrchestrator crash recovery (B8)', () => {
  test('reconciles orphaned runs: worktree-ready -> blocked_infra (resumable), else aborted', async () => {
    // Got past prep (has a worktree/baseCommit) -> resumable.
    repo.createRun(activeRun('run-live', 'task-1'));
    repo.patchRun('run-live', { currentPid: 999999, baseCommit: 'a'.repeat(40) });
    // Never prepared a worktree -> aborted (retry starts fresh).
    repo.createRun({ ...activeRun('run-prep', 'task-2'), status: 'preparing_workspace' });
    // A terminal run must be left untouched by recovery.
    repo.createRun({ ...activeRun('run-old', 'task-3'), status: 'blocked_tests' });

    const recovered = await orch.recoverInterruptedRuns();
    expect(recovered.map((r) => r.id).sort()).toEqual(['run-live', 'run-prep']);

    const live = repo.getRun('run-live')!;
    expect(live.status).toBe('blocked_infra');
    expect(live.currentPid).toBeUndefined();
    expect(live.blockMessage).toContain('resume to continue');

    const prep = repo.getRun('run-prep')!;
    expect(prep.status).toBe('aborted');
    expect(prep.finishedAt).toBeTruthy();

    expect(repo.getRun('run-old')!.status).toBe('blocked_tests');
  });
});

describe('RunOrchestrator resume (B8)', () => {
  test('resumes a blocked run in the existing worktree through to pr_ready', async () => {
    // First run blocks on a failing verifier.
    const failing = config({ verifier: { command: 'bash', args: ['-lc', 'exit 1'], blockingExitCodes: [] } });
    const started = orch.startRun('task-1', failing, [task('task-1')]);
    const blocked = await waitForTerminal(started.id);
    expect(blocked.status).toBe('blocked_tests');
    expect(blocked.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    // Resume with a passing verifier: re-implements in the same worktree, verifies, hands off.
    const passing = config();
    const resumed = orch.resumeRun(started.id, passing, [task('task-1')]);
    expect(resumed.id).toBe(started.id);
    const done = await waitForStatus(started.id, ['pr_ready', 'blocked_tests']);
    expect(done.status).toBe('pr_ready');
    // Reactivation cleared the prior terminal/blocked metadata (not both ready + blocked).
    expect(done.blockReason).toBeUndefined();
    expect(done.blockMessage).toBeUndefined();
    expect(done.finishedAt).toBeUndefined();

    // A second implementing attempt was recorded, flagged as a resume.
    const implementing = repo.listAttempts(started.id).filter((a) => a.phase === 'implementing');
    expect(implementing.length).toBeGreaterThanOrEqual(2);
    const started2 = repo.readEventsSince(0, started.id).filter((e) => e.type === 'agent.started');
    expect(started2.at(-1)?.payload).toMatchObject({ resumed: true });
  });

  test('refuses to resume a run with no prepared worktree', () => {
    repo.createRun({ ...activeRun('run-x', 'task-1'), status: 'blocked_tests' }); // no baseCommit
    expect(() => orch.resumeRun('run-x', config(), [task('task-1')])).toThrow(/no prepared worktree/);
  });

  test('refuses to resume when the task already has another active run (D20)', () => {
    const blocked = { ...activeRun('run-blocked', 'task-1'), status: 'blocked_tests' as const, baseCommit: 'a'.repeat(40) };
    repo.createRun(blocked);
    repo.createRun(activeRun('run-active', 'task-1')); // a concurrent active run for the same task
    expect(() => orch.resumeRun('run-blocked', config(), [task('task-1')])).toThrow(/active run/);
  });
});

describe('RunOrchestrator fix loop (B8)', () => {
  test('re-runs the agent on a verifier failure and reaches pr_ready once it passes', async () => {
    // Verifier fails the first time (creates a marker), passes the second.
    const cfg = config({
      maxFixAttempts: 1,
      verifier: { command: 'bash', args: ['-lc', 'test -f .beaver-fixed && exit 0 || { touch .beaver-fixed; exit 1; }'], blockingExitCodes: [] }
    });
    const started = orch.startRun('task-1', cfg, [task('task-1')]);
    const run = await waitForTerminal(started.id);
    expect(run.status).toBe('pr_ready');

    // Initial attempt + one fix attempt; a fix notice was recorded.
    const implementing = repo.listAttempts(started.id).filter((a) => a.phase === 'implementing');
    expect(implementing).toHaveLength(2);
    const errors = repo.readEventsSince(0, started.id).filter((e) => e.type === 'run.error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.payload.message)).toContain('auto-fixing');
  });

  test('blocks after exhausting maxFixAttempts (no fake success)', async () => {
    const cfg = config({ maxFixAttempts: 1, verifier: { command: 'bash', args: ['-lc', 'exit 1'], blockingExitCodes: [] } });
    const started = orch.startRun('task-1', cfg, [task('task-1')]);
    const run = await waitForTerminal(started.id);
    expect(run.status).toBe('blocked_tests');
    // initial + exactly one fix attempt, then block
    expect(repo.listAttempts(started.id).filter((a) => a.phase === 'implementing')).toHaveLength(2);
  });
});

describe("RunOrchestrator publisher actions (B9)", () => {
  async function readyRunId(): Promise<string> {
    const started = orch.startRun("task-1", config(), [task("task-1")]);
    const run = await waitForTerminal(started.id);
    expect(run.status).toBe("pr_ready");
    return started.id;
  }

  async function shipScript(name: string, exitCode: number): Promise<string> {
    const p = path.join(home, name);
    await fs.writeFile(p, `#!/usr/bin/env bash\necho shipped\nexit ${exitCode}\n`, { mode: 0o755 });
    return p;
  }

  test("runs a configured ship script, streams tool.* events, surfaces exit 0", async () => {
    const runId = await readyRunId();
    const cfg = config({ automation: { gitShipPushSnapshotScript: await shipScript("ship.sh", 0) } });
    const res = await orch.runAction(runId, "ship_push_snapshot", cfg);
    expect(res).toMatchObject({ action: "ship_push_snapshot", exitCode: 0 });
    const types = repo.readEventsSince(0, runId).map((e) => e.type);
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.exited");
    expect(repo.listArtifacts(runId).some((a) => a.kind === "tool:ship_push_snapshot")).toBe(true);
  });

  test("surfaces a non-zero ship script exit code (no fake success)", async () => {
    const runId = await readyRunId();
    const cfg = config({ automation: { gitShipPushSnapshotScript: await shipScript("ship-fail.sh", 3) } });
    expect((await orch.runAction(runId, "ship_push_snapshot", cfg)).exitCode).toBe(3);
  });

  test("rejects an unconfigured action explicitly", async () => {
    const runId = await readyRunId();
    await expect(orch.runAction(runId, "ship_fast_gate", config())).rejects.toThrow(/not configured/);
  });

  test("prepare_handoff rebuilds the handoff artifacts", async () => {
    const runId = await readyRunId();
    const res = await orch.runAction(runId, "prepare_handoff", config());
    expect(res.action).toBe("prepare_handoff");
    expect(res.exitCode).toBe(0);
    expect(existsSync(res.outputPath!)).toBe(true);
  });

  test("refuses an action on a run with no prepared worktree", async () => {
    repo.createRun({ ...activeRun("run-nb", "task-9"), status: "aborted" }); // non-active, no baseCommit
    await expect(orch.runAction("run-nb", "prepare_handoff", config())).rejects.toThrow(/no prepared worktree/);
  });

  test("rejects any action while the agent is still active (worktree may be mutating)", async () => {
    const cfg = config({ agentProfiles: { generic: { command: "bash", args: ["-lc", "sleep 300"] } } });
    const started = orch.startRun("task-1", cfg, [task("task-1")]);
    const r = await waitForStatus(started.id, ["implementing"]);
    expect(r.baseCommit).toBeTruthy(); // worktree exists, but the agent is still running
    const ship = config({ automation: { gitShipPushSnapshotScript: await shipScript("s.sh", 0) } });
    await expect(orch.runAction(started.id, "ship_push_snapshot", ship)).rejects.toThrow(/still active/);
    await orch.stopRun(started.id);
    await waitForStatus(started.id, ["aborted"]);
  });

  test("gates ship actions to pr_ready (rejected on a blocked run with a worktree)", async () => {
    const failing = config({ verifier: { command: "bash", args: ["-lc", "exit 1"], blockingExitCodes: [] } });
    const started = orch.startRun("task-1", failing, [task("task-1")]);
    const blocked = await waitForTerminal(started.id);
    expect(blocked.status).toBe("blocked_tests");
    expect(blocked.baseCommit).toBeTruthy();
    const ship = config({ automation: { gitShipPushSnapshotScript: await shipScript("s2.sh", 0) } });
    await expect(orch.runAction(started.id, "ship_push_snapshot", ship)).rejects.toThrow(/requires pr_ready/);
    // A non-ship action (rebuild handoff) is still allowed on a blocked run.
    expect((await orch.runAction(started.id, "prepare_handoff", config())).exitCode).toBe(0);
  });

  test("a missing/invalid ship script fails the action, never crashes the daemon", async () => {
    const runId = await readyRunId();
    const cfg = config({ automation: { gitShipPushSnapshotScript: "/no/such/beaver-script-xyz" } });
    const res = await orch.runAction(runId, "ship_push_snapshot", cfg);
    expect(res.exitCode).toBeNull(); // spawn failure surfaced, not an unhandled crash
    expect(repo.readEventsSince(0, runId).map((e) => e.type)).toContain("tool.exited");
  });
});

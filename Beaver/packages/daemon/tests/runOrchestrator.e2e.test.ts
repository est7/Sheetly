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

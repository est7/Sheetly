import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BeaverError, type ExternalTask, type Run } from '@beaver/core';
import { RunRepository } from '../src/repository/runRepository';
import { CURRENT_SCHEMA_VERSION } from '../src/repository/migrations';

let dbPath: string;
let repo: RunRepository;

beforeEach(() => {
  dbPath = path.join('/tmp', `bv-rr-${randomUUID().slice(0, 8)}.sqlite`);
  repo = new RunRepository(dbPath);
});

afterEach(async () => {
  repo.close();
  await fs.rm(dbPath, { force: true });
  await fs.rm(`${dbPath}-wal`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
});

const now = '2026-06-30T00:00:00.000Z';

function makeRun(overrides: Partial<Run> = {}): Run {
  const id = overrides.id ?? `run-${randomUUID().slice(0, 8)}`;
  return {
    id,
    taskId: 'task-1',
    status: 'discovered',
    repoPath: '/repo',
    worktreePath: `/wt/${id}`,
    branchName: `beaver/${id}`,
    baseBranch: 'main',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeTask(overrides: Partial<ExternalTask> = {}): ExternalTask {
  return {
    id: overrides.id ?? `task-${randomUUID().slice(0, 8)}`,
    sourceType: 'localJson',
    sourceProjectId: 'proj-1',
    title: 'Do the thing',
    description: 'desc',
    acceptanceCriteria: ['crit-a', 'crit-b'],
    productDocUrl: 'https://docs/x',
    assignee: 'est9',
    raw: { extra: 'kept' },
    ...overrides
  };
}

describe('RunRepository migrations (D8)', () => {
  test('opens at schema version 1 and is idempotent on reopen', () => {
    expect(repo.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    const run = makeRun();
    repo.createRun(run);
    repo.close();
    const reopened = new RunRepository(dbPath);
    expect(reopened.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(reopened.getRun(run.id)?.id).toBe(run.id);
    reopened.close();
    repo = new RunRepository(dbPath);
  });

  test('refuses to open a DB from a newer schema version (forward-only, no downgrade)', () => {
    repo.close();
    const raw = new Database(dbPath);
    raw.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => new RunRepository(dbPath)).toThrow();
    const check = new Database(dbPath);
    const version = (check.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    check.close();
    expect(version).toBe(CURRENT_SCHEMA_VERSION + 1); // not mutated/downgraded
    repo = new RunRepository(`${dbPath}.re`);
    dbPath = `${dbPath}.re`;
  });
});

describe('RunRepository runs + state machine', () => {
  test('rejects a runId that is unsafe as a filesystem path segment', () => {
    expect(() => repo.createRun(makeRun({ id: '../escape' }))).toThrow();
    expect(() => repo.createRun(makeRun({ id: 'a/b' }))).toThrow();
  });

  test('creates, gets, and lists runs newest-first', () => {
    const a = makeRun({ createdAt: '2026-06-30T00:00:01.000Z' });
    const b = makeRun({ createdAt: '2026-06-30T00:00:02.000Z' });
    repo.createRun(a);
    repo.createRun(b);
    expect(repo.getRun(a.id)?.id).toBe(a.id);
    expect(repo.listRuns().map((r) => r.id)).toEqual([b.id, a.id]);
  });

  test('updateRunStatus enforces the state machine', () => {
    const run = makeRun({ status: 'discovered' });
    repo.createRun(run);
    expect(repo.updateRunStatus(run.id, 'claimed').status).toBe('claimed');
    try {
      repo.updateRunStatus(run.id, 'done');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BeaverError);
      expect((error as BeaverError).code).toBe('ILLEGAL_TRANSITION');
    }
  });
});

describe('RunRepository attempts (D7 append-only)', () => {
  test('appends numbered attempts and finalizes immutably, roundtripping agent fields', () => {
    const run = makeRun();
    repo.createRun(run);
    const a1 = repo.appendAttempt({
      runId: run.id,
      phase: 'implementing',
      agentProfile: 'generic',
      command: 'codex',
      args: ['exec'],
      promptPath: '/wt/.runs/x/task.md',
      transcriptPath: '/wt/.runs/x/transcript.jsonl'
    });
    const a2 = repo.appendAttempt({ runId: run.id, phase: 'verifying' });
    expect([a1.attemptNumber, a2.attemptNumber]).toEqual([1, 2]);

    const finalized = repo.finalizeAttempt(a1.id, { exitCode: 0 });
    expect(finalized.exitCode).toBe(0);
    expect(finalized.finishedAt).toBeTruthy();

    const stored = repo.listAttempts(run.id).find((a) => a.id === a1.id)!;
    expect(stored.agentProfile).toBe('generic');
    expect(stored.promptPath).toBe('/wt/.runs/x/task.md');
    expect(stored.transcriptPath).toBe('/wt/.runs/x/transcript.jsonl');

    // immutable after finalize
    expect(() => repo.finalizeAttempt(a1.id, { exitCode: 1 })).toThrow();
  });

  test('rejects an attempt for a missing run (foreign key)', () => {
    expect(() => repo.appendAttempt({ runId: 'ghost', phase: 'implementing' })).toThrow();
  });
});

describe('RunRepository tasks + artifacts', () => {
  test('upserts and lists the full ExternalTask shape', () => {
    const task = makeTask();
    repo.upsertTasks([task]);
    const [loaded] = repo.listTasks('localJson');
    expect(loaded).toMatchObject({
      id: task.id,
      productDocUrl: 'https://docs/x',
      assignee: 'est9',
      acceptanceCriteria: ['crit-a', 'crit-b'],
      raw: { extra: 'kept' }
    });
  });

  test('registers and lists artifacts, rejecting orphans', () => {
    const run = makeRun();
    repo.createRun(run);
    const artifact = repo.registerArtifact({ runId: run.id, kind: 'summary', path: `/home/runs/${run.id}/summary.md` });
    expect(artifact.id).toBeTruthy();
    expect(repo.listArtifacts(run.id).map((a) => a.kind)).toEqual(['summary']);
    // orphan run and orphan attempt are both rejected by foreign keys
    expect(() => repo.registerArtifact({ runId: 'ghost', kind: 'summary', path: '/x' })).toThrow();
    expect(() =>
      repo.registerArtifact({ runId: run.id, attemptId: 'ghost-attempt', kind: 'log', path: '/y' })
    ).toThrow();
    // an attempt from a DIFFERENT run cannot be attached to this run's artifact
    const otherRun = makeRun();
    repo.createRun(otherRun);
    const otherAttempt = repo.appendAttempt({ runId: otherRun.id, phase: 'implementing' });
    expect(() =>
      repo.registerArtifact({ runId: run.id, attemptId: otherAttempt.id, kind: 'log', path: '/z' })
    ).toThrow();
  });
});

describe('RunRepository is the sole SSOT (D6)', () => {
  test('reads come only from the DB, ignoring any filesystem mirror', async () => {
    const run = makeRun();
    repo.createRun(run);
    // Plant decoy mirror files next to the DB; they must never be read as truth.
    const decoyDir = path.join(path.dirname(dbPath), 'runs', 'decoy-run');
    await fs.mkdir(decoyDir, { recursive: true });
    await fs.writeFile(path.join(decoyDir, 'run.json'), JSON.stringify(makeRun({ id: 'decoy-run' })));
    expect(repo.listRuns().map((r) => r.id)).toEqual([run.id]);
    expect(repo.getRun('decoy-run')).toBeNull();
    await fs.rm(path.join(path.dirname(dbPath), 'runs'), { recursive: true, force: true });
  });

  test('the repository module imports no filesystem module', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/repository/runRepository.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/from ['"]node:fs['"]/);
    expect(source).not.toMatch(/from ['"]fs['"]/);
  });
});

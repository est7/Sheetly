import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run, RunEvent } from '@beaver/core';
import { RunRepository } from '../src/repository/runRepository';
import { EventLog } from '../src/eventLog';

let home: string;
let repo: RunRepository;
let log: EventLog;
let runsDir: string;

function makeRun(id: string): Run {
  const now = '2026-06-30T00:00:00.000Z';
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
    updatedAt: now
  };
}

beforeEach(async () => {
  home = path.join('/tmp', `bv-ev-${randomUUID().slice(0, 8)}`);
  runsDir = path.join(home, 'runs');
  await fs.mkdir(home, { recursive: true });
  repo = new RunRepository(path.join(home, 'beaver.sqlite'));
  repo.createRun(makeRun('run-1'));
  log = new EventLog(repo, runsDir);
});

afterEach(async () => {
  repo.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe('EventLog append', () => {
  test('assigns a monotonic seq, mirrors to JSONL, and fans out to subscribers', async () => {
    const seen: RunEvent[] = [];
    log.on((event) => seen.push(event));
    const e1 = await log.append('run-1', 'run.created', { run: { id: 'run-1' } });
    const e2 = await log.append('run-1', 'agent.stdout', { line: 'hello' });

    expect(e1.seq).toBeGreaterThan(0);
    expect(e2.seq!).toBeGreaterThan(e1.seq!);
    expect(seen.map((e) => e.type)).toEqual(['run.created', 'agent.stdout']);

    const jsonl = await fs.readFile(path.join(runsDir, 'run-1', 'events.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).type).toBe('agent.stdout');
  });

  test('unsubscribe stops further delivery', async () => {
    const seen: RunEvent[] = [];
    const off = log.on((event) => seen.push(event));
    await log.append('run-1', 'run.created', {});
    off();
    await log.append('run-1', 'agent.exited', {});
    expect(seen).toHaveLength(1);
  });
});

describe('EventLog readSince (gap-free catch-up, D19)', () => {
  test('replays only events after the cursor, ordered by seq', async () => {
    const e1 = await log.append('run-1', 'run.created', {});
    await log.append('run-1', 'agent.started', {});
    await log.append('run-1', 'agent.exited', {});

    expect(log.readSince(0).map((e) => e.type)).toEqual(['run.created', 'agent.started', 'agent.exited']);
    expect(log.readSince(e1.seq!).map((e) => e.type)).toEqual(['agent.started', 'agent.exited']);
  });

  test('filters by runId when given', async () => {
    repo.createRun(makeRun('run-2'));
    await log.append('run-1', 'run.created', {});
    await log.append('run-2', 'run.created', {});
    const onlyRun1 = log.readSince(0, 'run-1');
    expect(onlyRun1).toHaveLength(1);
    expect(onlyRun1[0]!.runId).toBe('run-1');
  });
});

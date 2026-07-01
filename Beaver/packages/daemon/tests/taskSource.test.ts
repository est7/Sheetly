import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BeaverConfigSchema, BeaverError, type BeaverConfig } from '@beaver/core';
import { LarkBaseTaskSource, LocalJsonTaskSource, createTaskSource } from '../src/taskSource';
import { RunRepository } from '../src/repository/runRepository';

let home: string;
let env: NodeJS.ProcessEnv;
let file: string;

beforeEach(async () => {
  home = path.join('/tmp', `bv-ts-${randomUUID().slice(0, 8)}`);
  env = { BEAVER_HOME: home };
  file = path.join(home, 'tasks', 'local-tasks.json');
  await fs.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}): BeaverConfig {
  return BeaverConfigSchema.parse({
    defaultRepoPath: '/repos/app',
    taskSource: { type: 'localJson', path: '~/.beaver/tasks/local-tasks.json' },
    ...overrides
  });
}

function source(cfg: BeaverConfig = config()): LocalJsonTaskSource {
  const ts = cfg.taskSource as Extract<BeaverConfig['taskSource'], { type: 'localJson' }>;
  return new LocalJsonTaskSource({ path: ts.path, defaultRepoPath: cfg.defaultRepoPath }, env);
}

async function writeTasks(entries: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(entries), 'utf8');
}

describe('LocalJsonTaskSource path + storage-root contract', () => {
  test('resolves the ~/.beaver path under BEAVER_HOME and seeds a schema-valid sample when missing', async () => {
    const tasks = await source().pollAssignedTasks();
    expect(existsSync(file)).toBe(true); // created UNDER the temp beaver home, not a literal ./~ path
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0]!.sourceType).toBe('localJson');
    // sample carries no machine-specific repo path; empty repoPath falls back to defaultRepoPath
    expect(tasks[0]!.raw.repoPath).toBe('/repos/app');
  });
});

describe('LocalJsonTaskSource poll mapping', () => {
  test('maps LocalTask -> ExternalTask losslessly and applies defaultRepoPath', async () => {
    await writeTasks([
      {
        id: 't1',
        title: 'A',
        acceptanceCriteria: ['a'],
        repoPath: '/custom/repo',
        baseBranch: 'dev',
        requiredSubmodules: ['libs/x'],
        agentProfile: 'generic',
        assignee: 'est9'
      },
      { id: 't2', title: 'B' }
    ]);
    const tasks = await source().pollAssignedTasks();
    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.sourceType).toBe('localJson');
    expect(t1.assignee).toBe('est9');
    expect(t1.acceptanceCriteria).toEqual(['a']);
    expect(t1.raw.repoPath).toBe('/custom/repo');
    expect(t1.raw.baseBranch).toBe('dev');
    expect(t1.raw.requiredSubmodules).toEqual(['libs/x']);
    const t2 = tasks.find((t) => t.id === 't2')!;
    expect(t2.raw.repoPath).toBe('/repos/app'); // defaultRepoPath applied
  });

  test('fails explicitly on a malformed entry (no silent skip)', async () => {
    await writeTasks([{ title: 'missing id' }]);
    await expect(source().pollAssignedTasks()).rejects.toBeInstanceOf(BeaverError);
  });
});

describe('createTaskSource factory', () => {
  test('builds localJson and larkBase adapters', () => {
    expect(createTaskSource(config(), env)).toBeInstanceOf(LocalJsonTaskSource);
    const larkCfg = BeaverConfigSchema.parse({ taskSource: { type: 'larkBase' } });
    expect(createTaskSource(larkCfg, env)).toBeInstanceOf(LarkBaseTaskSource);
  });
});

describe('LocalJsonTaskSource claim/update are non-mutating interim stubs (D20/B7)', () => {
  test('claimTask returns true and updateTask is a no-op that never rewrites the source file', async () => {
    await writeTasks([{ id: 't1', title: 'A' }]);
    const src = source();
    await src.pollAssignedTasks();
    const before = await fs.readFile(file, 'utf8');
    expect(await src.claimTask('t1', { runId: 'r1', deviceId: 'd1', claimedAt: 'now' })).toBe(true);
    await src.updateTask('t1', { runnerStatus: 'running', runnerUpdatedAt: 'now' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });
});

describe('vertical: poll -> RunRepository', () => {
  test('polled tasks upsert into the repository and list back', async () => {
    await writeTasks([{ id: 't1', title: 'A', acceptanceCriteria: ['x'] }]);
    const tasks = await source().pollAssignedTasks();
    const repo = new RunRepository(path.join(home, 'beaver.sqlite'));
    repo.upsertTasks(tasks);
    expect(repo.listTasks('localJson').map((t) => t.id)).toContain('t1');
    repo.close();
  });
});

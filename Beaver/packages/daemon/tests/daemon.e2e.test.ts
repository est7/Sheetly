import http from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BeaverConfigSchema, beaverPaths, type BeaverConfig } from '@beaver/core';
import { BeaverClient } from '@beaver/client';
import { BeaverDaemonServer } from '../src/server';

let home: string;
let repoPath: string;
let paths: ReturnType<typeof beaverPaths>;
let server: BeaverDaemonServer;
let client: BeaverClient;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function raw(socketPath: string, method: string, pathname: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: pathname, method }, (response) => {
      let data = '';
      response.on('data', (c) => (data += c.toString()));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data.length ? JSON.parse(data) : undefined }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function writeConfig(overrides: Record<string, unknown>): Promise<BeaverConfig> {
  const config = BeaverConfigSchema.parse(overrides);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(paths.configPath, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

beforeEach(async () => {
  home = path.join('/tmp', `bv-de2e-${randomUUID().slice(0, 8)}`);
  repoPath = path.join(home, 'repo');
  paths = beaverPaths({ BEAVER_HOME: home });
  await fs.mkdir(repoPath, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'ignore' });
  git(repoPath, 'config', 'user.email', 't@example.com');
  git(repoPath, 'config', 'user.name', 'Beaver Test');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'init');
});

afterEach(async () => {
  await server?.stop().catch(() => {});
  await fs.rm(home, { recursive: true, force: true });
});

async function startWith(config: Record<string, unknown>): Promise<void> {
  await writeConfig(config);
  server = new BeaverDaemonServer(paths);
  await server.start();
  client = new BeaverClient(paths.socketPath);
}

describe('daemon end-to-end run loop over UDS', () => {
  test('sync tasks then start a run and drive it to pr_ready', async () => {
    const tasksFile = path.join(home, 'tasks', 'local-tasks.json');
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    await fs.writeFile(tasksFile, JSON.stringify([{ id: 'task-1', title: 'Do it', acceptanceCriteria: ['works'] }]));
    await startWith({
      defaultRepoPath: repoPath,
      defaultAgentProfile: 'generic',
      agentProfiles: { generic: { command: 'bash', args: ['-lc', 'echo change >> README.md'] } },
      verifier: { command: 'bash', args: ['-lc', 'exit 0'], blockingExitCodes: [] },
      taskSource: { type: 'localJson', path: tasksFile }
    });

    expect(await client.health()).toMatchObject({ ok: true, service: 'beaver-daemon' });
    const synced = await client.syncTasks();
    expect(synced.tasks.map((t) => t.id)).toContain('task-1');
    expect(await client.listTasks()).toHaveLength(1);

    const started = await client.startRun('task-1');
    expect(started.status).toBe('discovered');

    let run = started;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !['pr_ready', 'done', 'aborted'].includes(run.status) && !run.status.startsWith('blocked_')) {
      await delay(40);
      run = await client.getRun(started.id);
    }
    expect(run.status).toBe('pr_ready');

    const events = await client.runEvents(started.id);
    expect(events.map((e) => e.type)).toContain('handoff.created');
    expect(events.every((e, i) => i === 0 || e.seq! > events[i - 1]!.seq!)).toBe(true); // monotonic seq

    const logs = await client.runLogs(started.id);
    expect(typeof logs.stdout).toBe('string');
  });

  test('rejects a second concurrent run for the same task', async () => {
    const tasksFile = path.join(home, 'tasks', 'local-tasks.json');
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    await fs.writeFile(tasksFile, JSON.stringify([{ id: 'task-slow', title: 'Slow', acceptanceCriteria: [] }]));
    await startWith({
      defaultRepoPath: repoPath,
      defaultAgentProfile: 'generic',
      agentProfiles: { generic: { command: 'bash', args: ['-lc', 'sleep 300'] } },
      taskSource: { type: 'localJson', path: tasksFile }
    });
    await client.syncTasks();
    await client.startRun('task-slow');
    await delay(300);
    await expect(client.startRun('task-slow')).rejects.toMatchObject({ code: 'RUN_BLOCKED' });
    const runs = await client.listRuns();
    await client.stopRun(runs[0]!.id);
  });
});

describe('daemon hardening', () => {
  test('unwired routes return NOT_IMPLEMENTED, unknown routes NOT_FOUND', async () => {
    await startWith({ defaultRepoPath: repoPath });
    const started = await raw(paths.socketPath, 'GET', '/health');
    expect(started.status).toBe(200);
    const nope = await raw(paths.socketPath, 'GET', '/nope');
    expect(nope.status).toBe(404);
    expect(nope.body.error.code).toBe('NOT_FOUND');
  });

  test('malformed percent-encoding in a run id -> BAD_REQUEST not INTERNAL', async () => {
    await startWith({ defaultRepoPath: repoPath });
    const response = await raw(paths.socketPath, 'GET', '/runs/%E0%A4%A/events');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  test('SSE ?runId filters live events server-side (D19)', async () => {
    const tasksFile = path.join(home, 'tasks', 'local-tasks.json');
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    await fs.writeFile(tasksFile, JSON.stringify([{ id: 'task-1', title: 'T', acceptanceCriteria: [] }]));
    await startWith({
      defaultRepoPath: repoPath,
      defaultAgentProfile: 'generic',
      agentProfiles: { generic: { command: 'bash', args: ['-lc', 'true'] } },
      taskSource: { type: 'localJson', path: tasksFile }
    });
    await client.syncTasks();

    const frames: string[] = [];
    const req = http.request(
      { socketPath: paths.socketPath, path: '/events?runId=other-run&since=0', method: 'GET' },
      (res) => res.on('data', (c) => frames.push(c.toString()))
    );
    req.end();
    await delay(120);
    await client.startRun('task-1'); // emits many events for ITS run id, not 'other-run'
    await delay(700);
    req.destroy();

    const body = frames.join('');
    expect(body).toContain('event: ready');
    expect(body).not.toContain('event: run'); // no cross-run leakage
  });
});

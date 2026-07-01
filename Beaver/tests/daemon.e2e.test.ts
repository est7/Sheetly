import http from 'node:http';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BeaverDaemonServer, beaverPaths } from '@beaver/daemon';
import { BeaverClient } from '@beaver/client';
import type { BeaverConfig } from '@beaver/core';

function raw(socketPath: string, method: string, pathname: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: pathname, method }, (response) => {
      let data = '';
      response.on('data', (chunk) => (data += chunk.toString()));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: data.length ? JSON.parse(data) : undefined })
      );
    });
    request.on('error', reject);
    request.end();
  });
}

describe('daemon E2E over UDS', () => {
  const home = path.join('/tmp', `bv-${randomUUID().slice(0, 8)}`);
  const paths = beaverPaths({ BEAVER_HOME: home });
  let server: BeaverDaemonServer;
  let client: BeaverClient;

  beforeAll(async () => {
    server = new BeaverDaemonServer(paths);
    await server.start();
    client = new BeaverClient(paths.socketPath);
  });

  afterAll(async () => {
    await server.stop();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('serves health over the socket', async () => {
    expect(await client.health()).toMatchObject({ ok: true, service: 'beaver-daemon' });
  });

  it('creates the socket with 0600 mode (D4 access-control boundary)', async () => {
    const mode = (await fs.stat(paths.socketPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns default config then round-trips a save', async () => {
    const initial = await client.getConfig();
    expect(initial.workspaceRoot).toBe('~/.beaver/workspaces');
    const saved = await client.setConfig({ ...initial, defaultRepoPath: '/tmp/x' });
    expect(saved.defaultRepoPath).toBe('/tmp/x');
    expect((await client.getConfig()).defaultRepoPath).toBe('/tmp/x');
  });

  it('validates a real git worktree and rejects a non-repo', async () => {
    const repo = path.join(home, 'repo');
    await fs.mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    expect((await client.validateRepo(repo)).isGitWorktree).toBe(true);
    expect((await client.validateRepo(path.join(home, 'nope'))).isGitWorktree).toBe(false);
  });

  it('decodes an invalid config into a localizable BeaverError code', async () => {
    await expect(
      client.setConfig({ defaultAgentProfile: 'ghost', agentProfiles: { g: { command: 'x' } } } as unknown as BeaverConfig)
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('returns a NOT_IMPLEMENTED error body for known-but-unwired routes', async () => {
    const response = await raw(paths.socketPath, 'GET', '/runs');
    expect(response.status).toBe(501);
    expect(response.body).toEqual({ error: { code: 'NOT_IMPLEMENTED', params: { feature: 'GET /runs' } } });
  });

  it('returns NOT_FOUND for unknown routes', async () => {
    const response = await raw(paths.socketPath, 'GET', '/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

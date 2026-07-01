import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BeaverDaemonServer, beaverPaths } from '@beaver/daemon';

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

describe('daemon failure-mode hardening (audit phase 2)', () => {
  const homes: string[] = [];
  const freshHome = (tag: string): string => {
    const home = path.join('/tmp', `bv-${tag}-${randomUUID().slice(0, 8)}`);
    homes.push(home);
    return home;
  };

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  });

  it('does not leak a raw runtime/fs error message over the wire', async () => {
    const home = freshHome('leak');
    const paths = beaverPaths({ BEAVER_HOME: home });
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(paths.configPath); // config.json is a directory -> readFile throws EISDIR
    const server = new BeaverDaemonServer(paths);
    await server.start();
    try {
      const response = await raw(paths.socketPath, 'GET', '/config');
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL');
      expect(response.body.error.params).toEqual({});
      expect(JSON.stringify(response.body)).not.toContain('EISDIR');
    } finally {
      await server.stop();
    }
  });

  it('tears down the server + socket if a post-listen start step fails', async () => {
    const home = freshHome('startfail');
    const paths = beaverPaths({ BEAVER_HOME: home });
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(paths.pidPath); // daemon.pid is a directory -> writeFile throws
    const server = new BeaverDaemonServer(paths);
    await expect(server.start()).rejects.toBeTruthy();
    // A failed start must not leave a live daemon on the socket.
    await expect(fs.access(paths.socketPath)).rejects.toBeTruthy();
  });
});

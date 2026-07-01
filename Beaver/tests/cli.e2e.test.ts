import { promises as fs, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beaverPaths } from '@beaver/core';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliMain = path.join(repoRoot, 'apps/cli/src/main.ts');

/**
 * The CLI is exercised as a real `bun` process so exit codes, --json, and
 * localization are verified end to end. The daemon must be a SEPARATE process:
 * spawnSync blocks the test worker's event loop, so an in-process server would
 * deadlock (it could not answer the child's health check). We let the CLI
 * auto-spawn its own detached daemon and tear it down via the pidfile.
 */
describe('CLI E2E (real bun process + auto-spawned daemon)', () => {
  const home = path.join('/tmp', `bv-cli-${randomUUID().slice(0, 8)}`);
  const paths = beaverPaths({ BEAVER_HOME: home });

  function cli(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync('bun', [cliMain, ...args], {
      cwd: repoRoot,
      env: { ...process.env, BEAVER_HOME: home },
      encoding: 'utf8'
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  beforeAll(() => {
    const started = cli(['daemon', 'start']);
    expect(started.status).toBe(0);
  }, 20000);

  afterAll(async () => {
    try {
      const pid = Number((await fs.readFile(paths.pidPath, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      // daemon already gone
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  it('daemon status --json exits 0 with health json', () => {
    const { status, stdout } = cli(['daemon', 'status', '--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, service: 'beaver-daemon' });
  });

  it('config get --json exits 0 with the config', () => {
    const { status, stdout } = cli(['config', 'get', '--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).workspaceRoot).toBe('~/.beaver/workspaces');
  });

  it('repo validate exits 0 for a real worktree and 1 for a non-repo', () => {
    const repo = path.join(home, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    expect(cli(['repo', 'validate', repo]).status).toBe(0);
    expect(cli(['repo', 'validate', path.join(home, 'nope')]).status).toBe(1);
  });

  it('unimplemented command exits 1 with a NOT_IMPLEMENTED error body (--json)', () => {
    const { status, stderr } = cli(['runs', 'files', 'nonexistent', '--json']);
    expect(status).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe('NOT_IMPLEMENTED');
  });

  it('localizes the error to zh-CN via --lang', () => {
    const { status, stderr } = cli(['runs', 'files', 'nonexistent', '--lang', 'zh-CN']);
    expect(status).toBe(1);
    expect(stderr).toContain('尚未实现');
  });

  it('unknown command exits 1 with BAD_REQUEST', () => {
    expect(cli(['bogus']).status).toBe(1);
  });

  it('config set with empty stdin fails fast without spawning a daemon', () => {
    const freshHome = path.join('/tmp', `bv-cfgss-${randomUUID().slice(0, 8)}`);
    const result = spawnSync('bun', [cliMain, 'config', 'set', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, BEAVER_HOME: freshHome },
      input: '',
      encoding: 'utf8'
    });
    expect(result.status).toBe(1);
    expect(existsSync(path.join(freshHome, 'daemon.pid'))).toBe(false);
    rmSync(freshHome, { recursive: true, force: true });
  });

  it('daemon status exits 3 and spawns nothing when the daemon is down', () => {
    const freshHome = path.join('/tmp', `bv-statusdown-${randomUUID().slice(0, 8)}`);
    const result = spawnSync('bun', [cliMain, 'daemon', 'status'], {
      cwd: repoRoot,
      env: { ...process.env, BEAVER_HOME: freshHome },
      encoding: 'utf8'
    });
    expect(result.status).toBe(3);
    expect(existsSync(path.join(freshHome, 'daemon.pid'))).toBe(false);
    rmSync(freshHome, { recursive: true, force: true });
  });

  it('honors LC_ALL over LANG for locale resolution', () => {
    const freshHome = path.join('/tmp', `bv-loc-${randomUUID().slice(0, 8)}`);
    const result = spawnSync('bun', [cliMain, 'bogus'], {
      cwd: repoRoot,
      env: { ...process.env, BEAVER_HOME: freshHome, BEAVER_LANG: '', LANG: 'C.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
      encoding: 'utf8'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('请求无效');
    rmSync(freshHome, { recursive: true, force: true });
  });
});

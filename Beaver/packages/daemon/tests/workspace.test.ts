import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BeaverError } from '@beaver/core';
import { WorkspaceManager, normalizeRepoKey } from '../src/workspace';

let root: string;
let repoPath: string;
let wm: WorkspaceManager;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

beforeEach(async () => {
  root = path.join('/tmp', `bv-ws-${randomUUID().slice(0, 8)}`);
  repoPath = path.join(root, 'repo');
  await fs.mkdir(repoPath, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'ignore' });
  git(repoPath, 'config', 'user.email', 't@example.com');
  git(repoPath, 'config', 'user.name', 'Beaver Test');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'init');
  wm = new WorkspaceManager('git');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('WorkspaceManager.prepare', () => {
  test('creates an isolated worktree on a new branch and records the base commit', async () => {
    const worktreePath = path.join(root, 'wt-1');
    const { baseCommit } = await wm.prepare({ repoPath, worktreePath, branchName: 'beaver/x', baseBranch: 'main' });
    expect(existsSync(path.join(worktreePath, 'README.md'))).toBe(true);
    expect(baseCommit).toMatch(/^[0-9a-f]{40}$/);
    const head = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
    expect(head).toBe('beaver/x');
  });

  test('rejects an already-existing worktree path', async () => {
    const worktreePath = path.join(root, 'wt-2');
    await fs.mkdir(worktreePath, { recursive: true });
    await expect(
      wm.prepare({ repoPath, worktreePath, branchName: 'beaver/y', baseBranch: 'main' })
    ).rejects.toBeInstanceOf(BeaverError);
  });

  test('rejects an unsafe submodule path before touching Git', async () => {
    const worktreePath = path.join(root, 'wt-3');
    await expect(
      wm.prepare({ repoPath, worktreePath, branchName: 'beaver/z', baseBranch: 'main', requiredSubmodules: ['/abs'] })
    ).rejects.toMatchObject({ code: 'SUBMODULE_INVALID' });
    expect(existsSync(worktreePath)).toBe(false); // failed before any git mutation
  });

  test('rejects a non-repo path', async () => {
    await expect(
      wm.prepare({
        repoPath: path.join(root, 'not-a-repo'),
        worktreePath: path.join(root, 'wt-4'),
        branchName: 'beaver/n',
        baseBranch: 'main'
      })
    ).rejects.toMatchObject({ code: 'REPO_INVALID' });
  });

  test('serializes concurrent same-repo prepares (D18) so both worktrees are created', async () => {
    const [a, b] = await Promise.all([
      wm.prepare({ repoPath, worktreePath: path.join(root, 'wt-a'), branchName: 'beaver/a', baseBranch: 'main' }),
      wm.prepare({ repoPath, worktreePath: path.join(root, 'wt-b'), branchName: 'beaver/b', baseBranch: 'main' })
    ]);
    expect(a.baseCommit).toBe(b.baseCommit);
    expect(existsSync(path.join(root, 'wt-a', 'README.md'))).toBe(true);
    expect(existsSync(path.join(root, 'wt-b', 'README.md'))).toBe(true);
  });

  test('normalizes equivalent repo path spellings to one lock key (D18)', () => {
    const key = normalizeRepoKey(repoPath);
    expect(normalizeRepoKey(`${repoPath}/.`)).toBe(key);
    expect(normalizeRepoKey(`${repoPath}/`)).toBe(key);
  });
});

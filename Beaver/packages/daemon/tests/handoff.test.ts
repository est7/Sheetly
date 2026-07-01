import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HandoffBuilder } from '../src/handoff';

let root: string;
let repoPath: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

beforeEach(async () => {
  root = path.join('/tmp', `bv-hf-${randomUUID().slice(0, 8)}`);
  repoPath = path.join(root, 'repo');
  await fs.mkdir(repoPath, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'ignore' });
  git(repoPath, 'config', 'user.email', 't@example.com');
  git(repoPath, 'config', 'user.name', 'Beaver Test');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'init');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('HandoffBuilder.build', () => {
  test('writes summary.md + diff.patch from the worktree without pushing', async () => {
    // make a tracked change
    await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\nchanged line\n');
    const runDir = path.join(root, 'runs', 'run-1');
    const result = await new HandoffBuilder().build({
      worktreePath: repoPath,
      runDir,
      runId: 'run-1',
      branchName: 'beaver/x',
      baseCommit: 'abc123'
    });

    const summary = await fs.readFile(result.summaryPath, 'utf8');
    const diff = await fs.readFile(result.diffPath, 'utf8');
    expect(summary).toContain('beaver/x');
    expect(summary).toContain('No push');
    expect(diff).toContain('README.md');
    expect(diff).toContain('changed line');
  });
});

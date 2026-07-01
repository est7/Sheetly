import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskPackBuilder } from '../src/taskPack';

let root: string;
let builder: TaskPackBuilder;

beforeEach(() => {
  root = path.join('/tmp', `bv-tp-${randomUUID().slice(0, 8)}`);
  builder = new TaskPackBuilder();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function input(runId: string) {
  return {
    runId,
    worktreePath: path.join(root, 'wt'),
    runsDir: path.join(root, 'runs'),
    task: { id: 'task-1', title: 'Do the thing', description: 'details', acceptanceCriteria: ['crit a', 'crit b'] },
    constraints: { repoPath: '/repo', baseBranch: 'main', requiredSubmodules: ['libs/x'] },
    commands: ['pnpm test']
  };
}

describe('TaskPackBuilder.materialize', () => {
  test('writes the worktree prompt pack and creates the home run-dir mirror', async () => {
    const result = await builder.materialize(input('run-1'));
    const packDir = path.join(root, 'wt', '.runs', 'run-1');
    expect(result.packDir).toBe(packDir);
    expect(result.runDir).toBe(path.join(root, 'runs', 'run-1'));
    expect(existsSync(result.runDir)).toBe(true);
    for (const name of ['task.md', 'acceptance.md', 'constraints.md', 'commands.md', 'findings.json', 'transcript.jsonl']) {
      expect(existsSync(path.join(packDir, name))).toBe(true);
    }
    expect(result.artifacts.map((a) => a.kind)).toContain('taskpack:task.md');
  });

  test('acceptance lists every criterion and constraints carry the safety rules', async () => {
    await builder.materialize(input('run-2'));
    const packDir = path.join(root, 'wt', '.runs', 'run-2');
    const acceptance = await fs.readFile(path.join(packDir, 'acceptance.md'), 'utf8');
    expect(acceptance).toContain('crit a');
    expect(acceptance).toContain('crit b');
    const constraints = await fs.readFile(path.join(packDir, 'constraints.md'), 'utf8');
    expect(constraints).toContain('Do NOT push automatically');
    expect(constraints).toContain('.runs/run-2/findings.json');
    expect(constraints).toContain('libs/x');
    const findings = JSON.parse(await fs.readFile(path.join(packDir, 'findings.json'), 'utf8'));
    expect(findings).toEqual({ findings: [] });
  });

  test('rejects a runId that would escape the generated roots', async () => {
    await expect(builder.materialize({ ...input('x'), runId: '../escape' })).rejects.toMatchObject({
      code: 'BAD_REQUEST'
    });
    expect(existsSync(path.join(root, 'escape'))).toBe(false);
  });
});

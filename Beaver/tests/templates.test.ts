import { describe, expect, it } from 'vitest';
import { interpolateArgs, interpolateTemplate, type TemplateVariables } from '@beaver/core';

const vars: TemplateVariables = {
  taskId: 't1',
  runId: 'r1',
  runDir: '/runs/r1',
  repoPath: '/repo',
  worktreePath: '/wt',
  branchName: 'feat/x'
};

describe('command template interpolation', () => {
  it('replaces known variables', () => {
    expect(interpolateTemplate('--cd {{worktreePath}} --prompt {{runDir}}/task.md', vars)).toBe(
      '--cd /wt --prompt /runs/r1/task.md'
    );
  });

  it('rejects an unknown variable', () => {
    expect(() => interpolateTemplate('{{nope}}', vars)).toThrow(/Unknown command template variable/);
  });

  it('rejects a malformed placeholder instead of leaving it literal', () => {
    // Regression for the audit finding: `{{worktree-path}}` must fail fast, not
    // pass through unresolved into an agent's argv.
    expect(() => interpolateTemplate('{{worktree-path}}', vars)).toThrow(/Unknown command template variable/);
    expect(() => interpolateTemplate('{{ runDir }}/x', vars)).not.toThrow();
  });

  it('interpolates each argv entry', () => {
    expect(interpolateArgs(['exec', '--cd', '{{worktreePath}}'], vars)).toEqual(['exec', '--cd', '/wt']);
  });
});

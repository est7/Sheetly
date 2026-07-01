import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGitOrThrow } from '../git/gitExec';

export type HandoffInput = {
  gitBinary?: string;
  worktreePath: string;
  /** Home run-dir mirror where summary.md / diff.patch are written. */
  runDir: string;
  runId: string;
  branchName: string;
  baseCommit?: string;
};

export type HandoffResult = { summaryPath: string; diffPath: string };

/**
 * Safe local PR handoff: collects `git status --short` and the tracked
 * `git diff --binary HEAD --`, and writes summary.md + diff.patch into the run
 * dir. It NEVER pushes, force-pushes, or opens a remote PR (that is the
 * approval-gated PublisherAdapter, B9).
 */
export class HandoffBuilder {
  async build(input: HandoffInput): Promise<HandoffResult> {
    const gitBinary = input.gitBinary ?? 'git';
    // Fail fast on a git error (invalid worktree / failed diff) — never write a
    // fake "no changes" handoff on top of a failed command.
    const status = await runGitOrThrow(gitBinary, input.worktreePath, ['status', '--short']);
    const diff = await runGitOrThrow(gitBinary, input.worktreePath, ['diff', '--binary', 'HEAD', '--']);

    await fs.mkdir(input.runDir, { recursive: true });
    const summaryPath = path.join(input.runDir, 'summary.md');
    const diffPath = path.join(input.runDir, 'diff.patch');
    await fs.writeFile(summaryPath, renderSummary(input, status.stdout), 'utf8');
    await fs.writeFile(diffPath, diff.stdout, 'utf8');
    return { summaryPath, diffPath };
  }
}

function renderSummary(input: HandoffInput, statusShort: string): string {
  const changes = statusShort.trim().length > 0 ? statusShort.trimEnd() : '(no changes)';
  return `# Handoff — run ${input.runId}

- Branch: \`${input.branchName}\`
- Worktree: \`${input.worktreePath}\`
- Base commit: \`${input.baseCommit ?? '(unknown)'}\`

## git status --short

\`\`\`
${changes}
\`\`\`

The tracked diff is in \`diff.patch\`. No push or remote PR was performed
(remote publishing is approval-gated).
`;
}

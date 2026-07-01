import { promises as fs } from 'node:fs';
import { BeaverError, validateSubmodulePaths, type SubmoduleUpdateOptions } from '@beaver/core';
import { runGit, runGitOrThrow } from '../git/gitExec';

export type PrepareWorkspaceInput = {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  requiredSubmodules?: string[];
  submoduleUpdate?: SubmoduleUpdateOptions;
};

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Git-only workspace preparation (D18 + safety invariants). It validates the
 * repo, fetches, creates an isolated worktree on a new branch, initializes only
 * the selected (argv-safe) submodules, and records the base commit. Shared-`.git`
 * prep is serialized per repo so two same-repo runs don't race `config.lock` /
 * `packed-refs`. Never deletes anything.
 */
export class WorkspaceManager {
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly gitBinary = 'git') {}

  async prepare(input: PrepareWorkspaceInput): Promise<{ baseCommit: string }> {
    return this.withRepoLock(input.repoPath, () => this.doPrepare(input));
  }

  private async doPrepare(input: PrepareWorkspaceInput): Promise<{ baseCommit: string }> {
    const inside = await runGit(this.gitBinary, input.repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      throw new BeaverError('REPO_INVALID', { repoPath: input.repoPath });
    }
    if (await pathExists(input.worktreePath)) {
      throw new BeaverError('BAD_REQUEST', { detail: `worktree path already exists: ${input.worktreePath}` });
    }
    // Validate submodule paths BEFORE any Git mutation so a bad path fails fast.
    if (input.requiredSubmodules && input.requiredSubmodules.length > 0) {
      validateSubmodulePaths(input.requiredSubmodules);
    }

    await runGitOrThrow(this.gitBinary, input.repoPath, ['fetch', '--all', '--prune']);
    await runGitOrThrow(this.gitBinary, input.repoPath, [
      'worktree',
      'add',
      '-b',
      input.branchName,
      input.worktreePath,
      input.baseBranch
    ]);

    const head = await runGitOrThrow(this.gitBinary, input.worktreePath, ['rev-parse', 'HEAD']);
    const baseCommit = head.stdout.trim();

    if (input.requiredSubmodules && input.requiredSubmodules.length > 0) {
      await runGitOrThrow(this.gitBinary, input.worktreePath, [
        'submodule',
        'sync',
        '--recursive',
        '--',
        ...input.requiredSubmodules
      ]);
      await runGitOrThrow(this.gitBinary, input.worktreePath, this.submoduleUpdateArgs(input));
    }

    return { baseCommit };
  }

  private submoduleUpdateArgs(input: PrepareWorkspaceInput): string[] {
    const options = input.submoduleUpdate;
    const args = ['submodule', 'update', '--init'];
    if (options?.jobs) {
      args.push('--jobs', String(options.jobs));
    }
    if (options?.filter) {
      args.push(`--filter=${options.filter}`);
    }
    if (options?.depth) {
      args.push('--depth', String(options.depth));
    }
    if (options?.recursive) {
      args.push('--recursive');
    }
    args.push('--', ...(input.requiredSubmodules ?? []));
    return args;
  }

  /** Serialize shared-`.git` prep per repo (D18); a failure never blocks the queue. */
  private withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.repoLocks.get(repoPath) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    this.repoLocks.set(
      repoPath,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }
}

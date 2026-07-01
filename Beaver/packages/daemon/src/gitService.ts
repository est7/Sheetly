import path from 'node:path';
import type { RepoValidation } from '@beaver/core';
import { runGit } from './git/gitExec';

/**
 * Thin Git adapter for repo validation. All dynamic values are argv entries via
 * the shared `runGit` helper (`shell: false`); never shell-string concatenation.
 * Worktree/submodule operations live in WorkspaceManager.
 */
export class GitService {
  constructor(private readonly gitBinary = 'git') {}

  async validateRepo(repoPath: string): Promise<RepoValidation> {
    if (!path.isAbsolute(repoPath)) {
      return { repoPath, isGitWorktree: false, message: 'not_absolute' };
    }
    const inside = await runGit(this.gitBinary, repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { repoPath, isGitWorktree: false, message: 'not_a_worktree' };
    }
    const branch = await runGit(this.gitBinary, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return {
      repoPath,
      isGitWorktree: true,
      currentBranch: branch.code === 0 ? branch.stdout.trim() : undefined
    };
  }
}

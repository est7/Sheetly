import { spawn } from 'node:child_process';
import path from 'node:path';
import { BeaverError, type RepoValidation } from '@beaver/core';

type GitResult = { code: number | null; stdout: string; stderr: string };

/**
 * Thin Git adapter. All dynamic values are argv entries (`shell: false`); never
 * shell-string concatenation. B3 only needs repo validation; worktree/submodule
 * operations land in B5.
 */
export class GitService {
  constructor(private readonly gitBinary = 'git') {}

  async validateRepo(repoPath: string): Promise<RepoValidation> {
    if (!path.isAbsolute(repoPath)) {
      return { repoPath, isGitWorktree: false, message: 'not_absolute' };
    }
    const inside = await this.run(repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { repoPath, isGitWorktree: false, message: 'not_a_worktree' };
    }
    const branch = await this.run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return {
      repoPath,
      isGitWorktree: true,
      currentBranch: branch.code === 0 ? branch.stdout.trim() : undefined
    };
  }

  private run(cwd: string, args: string[]): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBinary, ['-C', cwd, ...args], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        reject(new BeaverError('GIT_FAILED', { detail: error instanceof Error ? error.message : String(error) }));
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }
}

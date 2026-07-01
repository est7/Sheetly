import { spawn } from 'node:child_process';
import { BeaverError } from '@beaver/core';

export type GitResult = { code: number | null; stdout: string; stderr: string };

/**
 * Run git argv-safe (`shell: false`, `-C <cwd>` + args) — never shell-string
 * concatenation. A spawn failure (e.g. git missing) becomes GIT_FAILED; a
 * non-zero exit is returned so the caller can classify it.
 */
export function runGit(gitBinary: string, cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

export async function runGitOrThrow(gitBinary: string, cwd: string, args: string[]): Promise<GitResult> {
  const result = await runGit(gitBinary, cwd, args);
  if (result.code !== 0) {
    const detail = `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`;
    throw new BeaverError('GIT_FAILED', { detail });
  }
  return result;
}

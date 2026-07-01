import { execFile } from 'node:child_process';

/** Whether a binary is resolvable on PATH (the `which <bin>` detection pattern). */
export function commandExists(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [binary], { env }, (error) => resolve(!error));
  });
}

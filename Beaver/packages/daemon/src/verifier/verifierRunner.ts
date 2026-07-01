import type { TemplateVariables, VerifierConfig } from '@beaver/core';
import { AgentRunner } from '../agent';

export type VerifyInput = {
  cwd: string;
  verifierLogPath: string;
  variables?: TemplateVariables;
};

export type VerifyStatus = 'passed' | 'blocked' | 'failed';
export type VerifyResult = { status: VerifyStatus; exitCode: number | null };

/**
 * Runs the configured verifier after a successful agent, reusing AgentRunner's
 * argv-safe process handling. stdout+stderr both stream to verifier.log.
 * Classification: exit 0 -> passed, blockingExitCodes -> blocked, otherwise
 * failed (a real failure is never masked as success).
 */
export class VerifierRunner {
  constructor(private readonly agent: AgentRunner = new AgentRunner()) {}

  async run(config: VerifierConfig, input: VerifyInput): Promise<VerifyResult> {
    const handle = this.agent.run({
      command: config.command,
      args: config.args,
      cwd: input.cwd,
      stdoutPath: input.verifierLogPath,
      stderrPath: input.verifierLogPath,
      blockingExitCodes: config.blockingExitCodes,
      variables: input.variables
    });
    const result = await handle.result;
    const status: VerifyStatus =
      result.status === 'succeeded' ? 'passed' : result.status === 'blocked' ? 'blocked' : 'failed';
    return { status, exitCode: result.exitCode };
  }
}

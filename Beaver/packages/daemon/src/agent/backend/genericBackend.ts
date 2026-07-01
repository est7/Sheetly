import { AgentRunner } from '../agentRunner';
import type {
  AgentBackend,
  AgentBackendHandle,
  AgentBackendOptions,
  AgentBackendResult,
  AgentBackendStatus,
  AgentMessage
} from './types';
import { commandExists } from './which';

const STATUS_MAP: Record<string, AgentBackendStatus> = {
  succeeded: 'completed',
  blocked: 'blocked',
  failed: 'failed',
  stopped: 'stopped'
};

/**
 * Escape hatch backend for a raw `{command, args}` profile (no provider). It
 * runs the command via AgentRunner and surfaces stdout lines as plain `text`
 * messages (no structured parsing — that is what the per-agent providers add).
 */
export class GenericBackend implements AgentBackend {
  readonly id = 'generic';

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly runner: AgentRunner = new AgentRunner()
  ) {}

  detect(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return commandExists(this.command, env);
  }

  run(options: AgentBackendOptions, onMessage: (message: AgentMessage) => void): AgentBackendHandle {
    let output = '';
    const handle = this.runner.run({
      command: options.executablePath ?? this.command,
      args: this.args,
      cwd: options.cwd,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      blockingExitCodes: options.blockingExitCodes,
      variables: options.variables,
      onStdout: (line) => {
        output += `${line}\n`;
        onMessage({ type: 'text', content: line });
      },
      onStderr: (line) => onMessage({ type: 'log', content: line })
    });
    const result = handle.result.then(
      (r): AgentBackendResult => ({ status: STATUS_MAP[r.status] ?? 'failed', output, exitCode: r.exitCode })
    );
    return { pid: handle.pid, result, stop: handle.stop };
  }
}

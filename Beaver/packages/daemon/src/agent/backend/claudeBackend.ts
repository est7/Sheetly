import { AgentRunner, type AgentRunHandle } from '../agentRunner';
import { filterBlockedArgs, type BlockedArgMode } from './argFilter';
import { parseClaudeLine } from './claudeStreamJson';
import type {
  AgentBackend,
  AgentBackendHandle,
  AgentBackendOptions,
  AgentBackendResult,
  AgentMessage
} from './types';
import { commandExists } from './which';

const DEFAULT_EXEC = 'claude';

/**
 * Claude Code adapter. Drives the CLI in headless stream-json mode: the prompt
 * is written as a stream-json frame on stdin (kept open for mid-run
 * control_request auto-approval), and stdout frames are parsed into normalized
 * AgentMessages. Structured, per the Multica reference protocol.
 */
export class ClaudeBackend implements AgentBackend {
  readonly id = 'claude-code';

  constructor(
    private readonly execPath: string = DEFAULT_EXEC,
    private readonly runner: AgentRunner = new AgentRunner()
  ) {}

  detect(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return commandExists(this.execPath, env);
  }

  run(options: AgentBackendOptions, onMessage: (message: AgentMessage) => void): AgentBackendHandle {
    const execPath = options.executablePath ?? this.execPath;
    const args = buildClaudeArgs(options);

    let assistantText = '';
    let finalText: string | undefined;
    let finalError: string | undefined;
    let sessionId: string | undefined = options.resumeSessionId;
    let sawResult = false;

    let handle: AgentRunHandle;
    const onStdout = (line: string): void => {
      const outcome = parseClaudeLine(line);
      for (const message of outcome.messages) {
        if (message.type === 'text' && message.content) {
          assistantText += message.content;
        }
        onMessage(message);
      }
      if (outcome.sessionId) {
        sessionId = outcome.sessionId;
      }
      if (outcome.finalText !== undefined) {
        finalText = outcome.finalText;
      }
      if (outcome.finalError !== undefined) {
        finalError = outcome.finalError;
      }
      if (outcome.controlResponse) {
        handle.writeStdin(outcome.controlResponse);
      }
      if (outcome.done) {
        sawResult = true;
        handle.closeStdin();
      }
    };

    handle = this.runner.run({
      command: execPath,
      args,
      cwd: options.cwd,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      blockingExitCodes: options.blockingExitCodes,
      stdin: 'pipe',
      onStdout,
      onStderr: (line) => onMessage({ type: 'log', content: line })
    });

    // Feed the prompt as the first stream-json frame. Node's stdin write is
    // buffered and stdout drains on the event loop, so there is no Go-style
    // banner deadlock — we can write immediately after spawn.
    handle.writeStdin(buildPromptFrame(options.promptText));

    const result = handle.result.then((runResult): AgentBackendResult => {
      const output = finalText ?? assistantText;
      let status: AgentBackendResult['status'];
      let error = finalError;
      if (runResult.status === 'stopped') {
        status = 'stopped';
      } else if (finalError !== undefined) {
        status = 'failed';
      } else if (runResult.status === 'blocked') {
        status = 'blocked';
      } else if (runResult.status === 'failed') {
        status = 'failed';
        error = error ?? `claude exited with code ${runResult.exitCode ?? 'null'}`;
      } else if (!sawResult) {
        // Exit 0 but the terminal stream-json `result` frame never arrived —
        // the run was truncated / died early. That is not a verified success.
        status = 'failed';
        error = 'claude exited without a stream-json result frame';
      } else {
        status = 'completed';
      }
      return { status, output, error, sessionId, exitCode: runResult.exitCode };
    });

    return { pid: handle.pid, result, stop: handle.stop };
  }
}

/** Daemon-owned flags a profile's extraArgs must not override, or the
 * stream-json protocol / parser breaks (last-wins CLI). */
const CLAUDE_BLOCKED_ARGS: Record<string, BlockedArgMode> = {
  '-p': 'standalone',
  '--output-format': 'withValue',
  '--input-format': 'withValue',
  '--permission-mode': 'withValue'
};

/** Protocol-critical flags Beaver owns; a stream-json child must not lose them. */
export function buildClaudeArgs(options: AgentBackendOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--permission-mode',
    'bypassPermissions',
    // No UI exists to render AskUserQuestion in a headless run; disallow it so
    // the agent surfaces clarification as an artifact instead of silently
    // inferring against an empty answer.
    '--disallowedTools',
    'AskUserQuestion'
  ];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt);
  }
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }
  if (options.extraArgs?.length) {
    args.push(...filterBlockedArgs(options.extraArgs, CLAUDE_BLOCKED_ARGS));
  }
  return args;
}

function buildPromptFrame(prompt: string): string {
  const payload = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] }
  };
  return `${JSON.stringify(payload)}\n`;
}

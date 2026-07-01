import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveBeaverHome } from '@beaver/core';
import { AgentRunner } from '../agentRunner';
import { filterBlockedArgs, type BlockedArgMode } from './argFilter';
import { PiTextSanitizer, parsePiEvent } from './piStream';
import type {
  AgentBackend,
  AgentBackendHandle,
  AgentBackendOptions,
  AgentBackendResult,
  AgentMessage
} from './types';
import { commandExists } from './which';

const DEFAULT_EXEC = 'pi';

/**
 * Pi CLI adapter. Runs `pi -p --mode json --session <path> ... <prompt>` with
 * the prompt as the trailing positional arg (pi does not read it from stdin;
 * stdin is closed immediately to deliver EOF and unblock pi's event loop). The
 * `--session` JSONL file doubles as the opaque session id: it is returned as
 * sessionId and expected back as resumeSessionId to continue the conversation.
 */
export class PiBackend implements AgentBackend {
  readonly id = 'pi';
  private readonly sessionDir: string;

  constructor(
    private readonly execPath: string = DEFAULT_EXEC,
    private readonly runner: AgentRunner = new AgentRunner(),
    sessionDir?: string
  ) {
    this.sessionDir = sessionDir ?? path.join(resolveBeaverHome(), 'pi-sessions');
  }

  detect(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return commandExists(this.execPath, env);
  }

  run(options: AgentBackendOptions, onMessage: (message: AgentMessage) => void): AgentBackendHandle {
    const execPath = options.executablePath ?? this.execPath;
    const sessionPath = options.resumeSessionId ?? path.join(this.sessionDir, `${randomUUID()}.jsonl`);
    ensureSessionFile(sessionPath);
    const args = buildPiArgs(options, sessionPath);

    const sanitizer = new PiTextSanitizer();
    let output = '';
    let finalError: string | undefined;

    const onStdout = (line: string): void => {
      const evt = parsePiEvent(line);
      switch (evt.kind) {
        case 'status':
          onMessage({ type: 'status', status: 'running' });
          break;
        case 'text_delta': {
          const text = sanitizer.drain(evt.delta);
          if (text) {
            output += text;
            onMessage({ type: 'text', content: text });
          }
          break;
        }
        case 'thinking':
          if (evt.delta) {
            onMessage({ type: 'thinking', content: evt.delta });
          }
          break;
        case 'tool_use':
          onMessage({ type: 'tool_use', tool: evt.tool, callId: evt.callId, input: evt.input });
          break;
        case 'tool_result':
          onMessage({ type: 'tool_result', callId: evt.callId, output: evt.output });
          break;
        case 'error':
          onMessage({ type: 'error', content: evt.message });
          finalError ??= evt.message;
          break;
        case 'retry_failed':
          finalError ??= evt.message;
          break;
        case 'ignore':
          break;
      }
    };

    const handle = this.runner.run({
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
    // pi reads the prompt from argv; deliver an immediate stdin EOF so pi does
    // not stall awaiting interactive input under a daemon parent.
    handle.closeStdin();

    const result = handle.result.then((runResult): AgentBackendResult => {
      const tail = sanitizer.flush();
      if (tail) {
        output += tail;
        onMessage({ type: 'text', content: tail });
      }
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
        error = `pi exited with code ${runResult.exitCode ?? 'null'}`;
      } else {
        status = 'completed';
      }
      return { status, output, error, sessionId: sessionPath, exitCode: runResult.exitCode };
    });

    return { pid: handle.pid, result, stop: handle.stop };
  }
}

/** pi refuses to start when --session points at a missing file; create it
 * upfront and leave an existing (resumed) file untouched. */
function ensureSessionFile(sessionPath: string): void {
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, '', { flag: 'a' });
}

/** Daemon-owned flags a profile's extraArgs must not override; --mode json is
 * the event-stream protocol and --session is daemon-managed. */
const PI_BLOCKED_ARGS: Record<string, BlockedArgMode> = {
  '-p': 'standalone',
  '--print': 'standalone',
  '--mode': 'withValue',
  '--session': 'withValue'
};

export function buildPiArgs(options: AgentBackendOptions, sessionPath: string): string[] {
  const args = ['-p', '--mode', 'json', '--session', sessionPath];
  if (options.model) {
    const [provider, model] = splitPiModel(options.model);
    if (provider) {
      args.push('--provider', provider);
    }
    if (model) {
      args.push('--model', model);
    }
  }
  if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt);
  }
  if (options.extraArgs?.length) {
    args.push(...filterBlockedArgs(options.extraArgs, PI_BLOCKED_ARGS));
  }
  // The prompt is positional and MUST be the final argument.
  args.push(options.promptText);
  return args;
}

/** "provider/model" -> [provider, model]; a bare "model" -> ["", "model"]. */
export function splitPiModel(spec: string): [string, string] {
  const s = spec.trim();
  const i = s.indexOf('/');
  return i >= 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : ['', s];
}

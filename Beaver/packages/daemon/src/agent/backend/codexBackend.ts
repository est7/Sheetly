import { AgentRunner, type AgentRunHandle } from '../agentRunner';
import { CodexRpcClient } from './codexRpc';
import { extractThreadId } from './codexProtocol';
import type {
  AgentBackend,
  AgentBackendHandle,
  AgentBackendOptions,
  AgentBackendResult,
  AgentMessage
} from './types';
import { commandExists } from './which';

const DEFAULT_EXEC = 'codex';

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Codex adapter. Drives `codex app-server --listen stdio://` over JSON-RPC 2.0:
 * initialize -> initialized -> thread/start|resume -> turn/start, then streams
 * turn notifications as normalized AgentMessages until the turn completes. The
 * thread id is the opaque session id, round-tripped via resumeSessionId. A
 * failed/aborted turn or a premature process exit yields failed, never a fake
 * success.
 */
export class CodexBackend implements AgentBackend {
  readonly id = 'codex';

  constructor(
    private readonly execPath: string = DEFAULT_EXEC,
    private readonly runner: AgentRunner = new AgentRunner()
  ) {}

  detect(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return commandExists(this.execPath, env);
  }

  run(options: AgentBackendOptions, onMessage: (message: AgentMessage) => void): AgentBackendHandle {
    const execPath = options.executablePath ?? this.execPath;
    const args = ['app-server', '--listen', 'stdio://', ...(options.extraArgs ?? [])];

    let output = '';
    let finalError: string | undefined;
    let aborted = false;
    let turnCompleted = false;
    let sessionId: string | undefined = options.resumeSessionId;
    const turnDone = deferred();

    let handle: AgentRunHandle;
    const client = new CodexRpcClient((data) => handle.writeStdin(data));
    client.onEvent = (event): void => {
      switch (event.kind) {
        case 'status':
          onMessage({ type: 'status', status: 'running', sessionId });
          break;
        case 'text':
          output += event.text;
          onMessage({ type: 'text', content: event.text });
          break;
        case 'tool_use':
          onMessage({ type: 'tool_use', tool: event.tool, callId: event.callId, input: event.input });
          break;
        case 'tool_result':
          onMessage({ type: 'tool_result', tool: event.tool, callId: event.callId, output: event.output });
          break;
        case 'turn_error':
          finalError ??= event.message;
          break;
        case 'turn_done':
          turnCompleted = true;
          if (event.aborted) {
            aborted = true;
          }
          turnDone.resolve();
          break;
      }
    };

    handle = this.runner.run({
      command: execPath,
      args,
      cwd: options.cwd,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      stdin: 'pipe',
      onStdout: (line) => client.handleLine(line),
      onStderr: (line) => onMessage({ type: 'log', content: line })
    });

    // If codex dies before the turn resolves, surface the exit as a failure
    // rather than hanging on a response that will never arrive — or, worse,
    // reporting a completed turn that never actually finished.
    void handle.result.then((runResult) => {
      if (!turnCompleted) {
        finalError ??= `codex exited before completing the turn (code ${runResult.exitCode ?? 'null'})`;
      }
      client.failAll(new Error(`codex exited with code ${runResult.exitCode ?? 'null'}`));
      turnDone.resolve();
    });

    const driver = (async (): Promise<void> => {
      await client.request('initialize', {
        clientInfo: { name: 'beaver', title: 'Beaver', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      });
      client.notify('initialized');
      sessionId = await startOrResumeThread(client, options);
      client.setThreadId(sessionId);
      await client.request('turn/start', {
        threadId: sessionId,
        input: [{ type: 'text', text: options.promptText }]
      });
      await turnDone.promise;
    })();

    const result = (async (): Promise<AgentBackendResult> => {
      try {
        await driver;
      } catch (error) {
        finalError ??= error instanceof Error ? error.message : String(error);
      } finally {
        handle.closeStdin(); // let codex run its shutdown path and exit
      }
      const runResult = await handle.result;

      let status: AgentBackendResult['status'];
      let error = finalError;
      if (runResult.status === 'stopped') {
        status = 'stopped';
      } else if (finalError !== undefined) {
        status = 'failed';
      } else if (aborted) {
        status = 'failed';
        error = 'codex turn was aborted';
      } else if (runResult.status === 'blocked') {
        status = 'blocked';
      } else if (runResult.status === 'failed') {
        status = 'failed';
        error = `codex exited with code ${runResult.exitCode ?? 'null'}`;
      } else {
        status = 'completed';
      }
      return { status, output, error, sessionId, exitCode: runResult.exitCode };
    })();

    return { pid: handle.pid, result, stop: handle.stop };
  }
}

/** thread/resume the prior thread when a session id is supplied, falling back
 * to a fresh thread/start; otherwise start fresh. Returns the thread id. */
async function startOrResumeThread(client: CodexRpcClient, options: AgentBackendOptions): Promise<string> {
  if (options.resumeSessionId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId: options.resumeSessionId,
        cwd: options.cwd,
        model: options.model ?? null,
        developerInstructions: options.systemPrompt ?? null
      });
      const threadId = extractThreadId(resumed);
      if (threadId) {
        return threadId;
      }
    } catch {
      // Resume failed (thread GC'd, schema drift); fall through to a fresh start.
    }
  }
  const started = await client.request('thread/start', {
    cwd: options.cwd,
    model: options.model ?? null,
    developerInstructions: options.systemPrompt ?? null,
    persistExtendedHistory: true
  });
  const threadId = extractThreadId(started);
  if (!threadId) {
    throw new Error('codex thread/start returned no thread id');
  }
  return threadId;
}

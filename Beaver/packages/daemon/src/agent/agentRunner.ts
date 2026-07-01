import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { interpolateArgs, interpolateTemplate, type TemplateVariables } from '@beaver/core';

export type AgentRunInput = {
  command: string;
  args: string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  blockingExitCodes?: number[];
  variables?: TemplateVariables;
  /** 'pipe' opens a writable stdin (stream-json agents need it); default 'ignore'. */
  stdin?: 'ignore' | 'pipe';
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
};

export type AgentRunStatus = 'succeeded' | 'blocked' | 'failed' | 'stopped';
export type AgentRunResult = { status: AgentRunStatus; exitCode: number | null; signal: NodeJS.Signals | null };
export type AgentRunHandle = {
  pid: number | undefined;
  result: Promise<AgentRunResult>;
  stop: () => void;
  /** Write a frame to the child's stdin; no-op unless spawned with stdin: 'pipe'. */
  writeStdin: (data: string) => void;
  /** Close the child's stdin; no-op unless spawned with stdin: 'pipe'. */
  closeStdin: () => void;
};

/**
 * Spawns a headless agent as a detached process GROUP (never a shell — argv
 * only; templates interpolate per argv entry). stdout/stderr are appended raw to
 * log files and streamed line-by-line to callbacks. `stop` escalates
 * SIGINT -> SIGTERM -> SIGKILL to the whole group so child processes die too
 * (validated by the runtime spike). Exit is classified: 0 succeeded /
 * blockingExitCodes blocked / stopped / otherwise failed.
 */
export class AgentRunner {
  constructor(private readonly graceMs = 2000) {}

  run(input: AgentRunInput): AgentRunHandle {
    const command = input.variables ? interpolateTemplate(input.command, input.variables) : input.command;
    const args = input.variables ? interpolateArgs(input.args, input.variables) : input.args;

    const child = spawn(command, args, {
      cwd: input.cwd,
      detached: true, // new process group; child.pid is the group leader
      shell: false,
      stdio: [input.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    // A stream-json child may exit before draining stdin; swallow the resulting
    // EPIPE so it never crashes the daemon process.
    child.stdin?.on('error', () => {});

    const outStream = createWriteStream(input.stdoutPath, { flags: 'a' });
    const errStream = createWriteStream(input.stderrPath, { flags: 'a' });
    streamLines(child.stdout, outStream, input.onStdout);
    streamLines(child.stderr, errStream, input.onStderr);

    let stopped = false;
    const timers: NodeJS.Timeout[] = [];

    const result = new Promise<AgentRunResult>((resolve) => {
      child.on('close', (code, signal) => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        outStream.end();
        errStream.end();
        resolve({ status: classify(code, signal, stopped, input.blockingExitCodes ?? []), exitCode: code, signal });
      });
      // A spawn failure (ENOENT/EACCES — e.g. a stale configured script path)
      // emits 'error' and never 'close'. Without this handler Node treats it as
      // an unhandled error and kills the daemon; resolve it as a failed run.
      child.on('error', (error) => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        errStream.write(`spawn failed: ${error.message}\n`);
        outStream.end();
        errStream.end();
        resolve({ status: 'failed', exitCode: null, signal: null });
      });
    });

    const stop = (): void => {
      stopped = true;
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }
      signalGroup(pid, 'SIGINT');
      timers.push(setTimeout(() => signalGroup(pid, 'SIGTERM'), this.graceMs));
      timers.push(setTimeout(() => signalGroup(pid, 'SIGKILL'), this.graceMs * 2));
    };

    const writeStdin = (data: string): void => {
      if (!child.stdin || child.stdin.destroyed) {
        return;
      }
      try {
        child.stdin.write(data);
      } catch {
        // stdin already gone (child exited) — nothing to deliver
      }
    };

    const closeStdin = (): void => {
      if (!child.stdin || child.stdin.destroyed) {
        return;
      }
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    };

    return { pid: child.pid, result, stop, writeStdin, closeStdin };
  }
}

function classify(
  code: number | null,
  _signal: NodeJS.Signals | null,
  stopped: boolean,
  blockingExitCodes: number[]
): AgentRunStatus {
  if (stopped) {
    return 'stopped';
  }
  if (code === 0) {
    return 'succeeded';
  }
  if (code !== null && blockingExitCodes.includes(code)) {
    return 'blocked';
  }
  return 'failed';
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // negative pid => whole process group
  } catch {
    // group already gone
  }
}

function streamLines(
  stream: NodeJS.ReadableStream | null,
  sink: NodeJS.WritableStream,
  onLine?: (line: string) => void
): void {
  if (!stream) {
    return;
  }
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    sink.write(chunk);
    if (!onLine) {
      return;
    }
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  // Flush a final line that the process wrote without a trailing newline.
  stream.on('end', () => {
    if (onLine && buffer.length > 0) {
      onLine(buffer);
      buffer = '';
    }
  });
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRunner, type AgentRunInput } from '../src/agent';

let dir: string;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  dir = path.join('/tmp', `bv-ag-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function baseInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    command: 'bash',
    args: ['-c', 'echo hello; exit 0'],
    cwd: dir,
    stdoutPath: path.join(dir, 'stdout.log'),
    stderrPath: path.join(dir, 'stderr.log'),
    ...overrides
  };
}

describe('AgentRunner exit classification', () => {
  test('exit 0 -> succeeded, and stdout is captured to the log + line callback', async () => {
    const lines: string[] = [];
    const handle = new AgentRunner().run(baseInput({ onStdout: (l) => lines.push(l) }));
    const result = await handle.result;
    expect(result.status).toBe('succeeded');
    expect(lines).toContain('hello');
    await delay(30);
    expect(await fs.readFile(path.join(dir, 'stdout.log'), 'utf8')).toContain('hello');
  });

  test('a blocking exit code -> blocked', async () => {
    const handle = new AgentRunner().run(baseInput({ args: ['-c', 'exit 2'], blockingExitCodes: [2] }));
    expect((await handle.result).status).toBe('blocked');
  });

  test('other nonzero -> failed', async () => {
    const handle = new AgentRunner().run(baseInput({ args: ['-c', 'exit 1'], blockingExitCodes: [2] }));
    expect((await handle.result).status).toBe('failed');
  });
});

describe('AgentRunner argv safety', () => {
  test('interpolates template variables per argv entry (no shell)', async () => {
    const lines: string[] = [];
    const handle = new AgentRunner().run(
      baseInput({
        args: ['-c', 'echo cd={{worktreePath}}'],
        variables: {
          taskId: 't',
          runId: 'r',
          runDir: '/rd',
          repoPath: '/repo',
          worktreePath: '/wt/here',
          branchName: 'b'
        },
        onStdout: (l) => lines.push(l)
      })
    );
    await handle.result;
    expect(lines).toContain('cd=/wt/here');
  });
});

describe('AgentRunner stop', () => {
  test('SIGINT to the group stops the child and its grandchildren', async () => {
    let gcPid = 0;
    const handle = new AgentRunner(50).run(
      baseInput({
        args: ['-c', 'sleep 300 & echo "GC:$!"; echo "CH:$$"; wait'],
        onStdout: (line) => {
          const match = /GC:(\d+)/.exec(line);
          if (match) {
            gcPid = Number(match[1]);
          }
        }
      })
    );
    const deadline = Date.now() + 3000;
    while (gcPid === 0 && Date.now() < deadline) {
      await delay(20);
    }
    expect(gcPid).toBeGreaterThan(0);
    handle.stop();
    const result = await handle.result;
    expect(result.status).toBe('stopped');
    await delay(50);
    expect(alive(gcPid)).toBe(false); // grandchild reaped via process-group signal
  });
});

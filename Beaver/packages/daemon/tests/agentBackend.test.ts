import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BeaverError } from '@beaver/core';
import {
  GenericBackend,
  buildBackendRegistry,
  commandExists,
  resolveNamedBackend,
  type AgentBackendOptions,
  type AgentMessage
} from '../src/agent/backend';

let dir: string;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  dir = path.join('/tmp', `bv-be-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function opts(overrides: Partial<AgentBackendOptions> = {}): AgentBackendOptions {
  return {
    cwd: dir,
    promptText: 'do the thing',
    stdoutPath: path.join(dir, 'stdout.log'),
    stderrPath: path.join(dir, 'stderr.log'),
    ...overrides
  };
}

describe('GenericBackend', () => {
  test('runs a command, surfaces stdout as text messages, completes', async () => {
    const messages: AgentMessage[] = [];
    const handle = new GenericBackend('bash', ['-lc', 'echo hello; echo world']).run(opts(), (m) => messages.push(m));
    const result = await handle.result;
    expect(result.status).toBe('completed');
    expect(result.output).toContain('hello');
    expect(messages.filter((m) => m.type === 'text').map((m) => m.content)).toEqual(['hello', 'world']);
  });

  test('classifies a blocking exit code as blocked', async () => {
    const handle = new GenericBackend('bash', ['-lc', 'exit 2']).run(opts({ blockingExitCodes: [2] }), () => {});
    expect((await handle.result).status).toBe('blocked');
  });

  test('stop yields stopped', async () => {
    const handle = new GenericBackend('bash', ['-lc', 'sleep 300']).run(opts(), () => {});
    await delay(150);
    handle.stop();
    expect((await handle.result).status).toBe('stopped');
  });

  test('detect reflects PATH availability', async () => {
    expect(await new GenericBackend('bash', []).detect()).toBe(true);
    expect(await new GenericBackend('beaver-no-such-binary-xyz', []).detect()).toBe(false);
    expect(await commandExists('bash')).toBe(true);
  });
});

describe('backend registry', () => {
  test('resolves registered providers and rejects unknown ones (no fake)', () => {
    const registry = buildBackendRegistry([]);
    try {
      resolveNamedBackend(registry, 'claude-code');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BeaverError);
      expect((error as BeaverError).code).toBe('NOT_IMPLEMENTED');
    }
  });
});

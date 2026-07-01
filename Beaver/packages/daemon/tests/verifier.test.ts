import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VerifierConfig } from '@beaver/core';
import { VerifierRunner } from '../src/verifier';

let dir: string;
let logPath: string;

beforeEach(async () => {
  dir = path.join('/tmp', `bv-vf-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  logPath = path.join(dir, 'verifier.log');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function verifier(cmd: string, blocking: number[] = []): VerifierConfig {
  return { command: 'bash', args: ['-lc', cmd], blockingExitCodes: blocking };
}

describe('VerifierRunner', () => {
  test('exit 0 -> passed and writes verifier.log', async () => {
    const result = await new VerifierRunner().run(verifier('echo verifying; exit 0'), { cwd: dir, verifierLogPath: logPath });
    expect(result.status).toBe('passed');
    expect(await fs.readFile(logPath, 'utf8')).toContain('verifying');
  });

  test('a blocking exit code -> blocked', async () => {
    const result = await new VerifierRunner().run(verifier('exit 2', [2]), { cwd: dir, verifierLogPath: logPath });
    expect(result.status).toBe('blocked');
  });

  test('other nonzero -> failed (real failure, not masked)', async () => {
    const result = await new VerifierRunner().run(verifier('exit 1', [2]), { cwd: dir, verifierLogPath: logPath });
    expect(result.status).toBe('failed');
  });
});

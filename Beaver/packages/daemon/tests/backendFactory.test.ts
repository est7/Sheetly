import { describe, expect, test } from 'bun:test';
import { AgentRunner } from '../src/agent';
import { createBackend } from '../src/agent/backend';

describe('createBackend', () => {
  const runner = new AgentRunner();

  test('selects the structured adapter for each provider', () => {
    expect(createBackend({ provider: 'claude-code', command: 'claude', args: [] }, runner).id).toBe('claude-code');
    expect(createBackend({ provider: 'pi', command: 'pi', args: [] }, runner).id).toBe('pi');
    expect(createBackend({ provider: 'codex', command: 'codex', args: [] }, runner).id).toBe('codex');
  });

  test('falls back to the generic backend when no provider is set', () => {
    expect(createBackend({ command: 'bash', args: ['-lc', 'true'] }, runner).id).toBe('generic');
  });
});

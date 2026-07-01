import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ClaudeBackend,
  buildClaudeArgs,
  parseClaudeLine,
  type AgentBackendOptions,
  type AgentMessage
} from '../src/agent/backend';

describe('parseClaudeLine', () => {
  test('ignores blank and non-JSON banner lines', () => {
    expect(parseClaudeLine('').messages).toEqual([]);
    expect(parseClaudeLine('Claude Code v2.1.0 starting…').messages).toEqual([]);
  });

  test('system frame yields session id and running status', () => {
    const outcome = parseClaudeLine(JSON.stringify({ type: 'system', session_id: 'sess-1' }));
    expect(outcome.sessionId).toBe('sess-1');
    expect(outcome.messages).toEqual([{ type: 'status', status: 'running', sessionId: 'sess-1' }]);
  });

  test('assistant frame maps text, thinking, tool_use blocks', () => {
    const outcome = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'thinking', text: 'hmm' },
            { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }
          ]
        }
      })
    );
    expect(outcome.messages).toEqual([
      { type: 'text', content: 'hi' },
      { type: 'thinking', content: 'hmm' },
      { type: 'tool_use', tool: 'Bash', callId: 'call-1', input: { command: 'ls' } }
    ]);
  });

  test('user frame maps tool_result with stringified content', () => {
    const outcome = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: { ok: true } }] }
      })
    );
    expect(outcome.messages).toEqual([{ type: 'tool_result', callId: 'call-1', output: '{"ok":true}' }]);
  });

  test('result frame carries final text and done', () => {
    const ok = parseClaudeLine(JSON.stringify({ type: 'result', session_id: 's', result: 'done text' }));
    expect(ok).toMatchObject({ finalText: 'done text', done: true, sessionId: 's' });
    expect(ok.finalError).toBeUndefined();

    const err = parseClaudeLine(JSON.stringify({ type: 'result', result: 'boom', is_error: true }));
    expect(err.finalError).toBe('boom');
  });

  test('control_request produces an auto-approve response forcing foreground', () => {
    const outcome = parseClaudeLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-9',
        request: { input: { run_in_background: true, command: 'ls' } }
      })
    );
    expect(outcome.controlResponse).toBeDefined();
    const parsed = JSON.parse(outcome.controlResponse as string);
    expect(parsed.response.request_id).toBe('req-9');
    expect(parsed.response.response.behavior).toBe('allow');
    expect(parsed.response.response.updatedInput.run_in_background).toBe(false);
  });
});

describe('buildClaudeArgs', () => {
  test('hardcodes protocol flags and appends optional ones', () => {
    const args = buildClaudeArgs({
      cwd: '/w',
      promptText: 'x',
      stdoutPath: '/w/o',
      stderrPath: '/w/e',
      model: 'claude-opus-4-8',
      systemPrompt: 'be terse',
      resumeSessionId: 'sess-7',
      extraArgs: ['--foo']
    });
    expect(args.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']);
    expect(args).toContain('bypassPermissions');
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-8']));
    expect(args).toEqual(expect.arrayContaining(['--append-system-prompt', 'be terse']));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-7']));
    expect(args).toContain('--foo');
  });
});

describe('ClaudeBackend (fake CLI)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join('/tmp', `bv-claude-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function fakeClaude(bodyLines: string[]): Promise<string> {
    const script = path.join(dir, 'fake-claude.sh');
    const emits = bodyLines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join('\n');
    await fs.writeFile(script, `#!/usr/bin/env bash\n${emits}\nexit 0\n`, { mode: 0o755 });
    return script;
  }

  function opts(): AgentBackendOptions {
    return {
      cwd: dir,
      promptText: 'do the thing',
      stdoutPath: path.join(dir, 'stdout.log'),
      stderrPath: path.join(dir, 'stderr.log')
    };
  }

  test('parses a happy-path stream into completed with final text and session id', async () => {
    const script = await fakeClaude([
      JSON.stringify({ type: 'system', session_id: 'sess-abc' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] }
      }),
      JSON.stringify({ type: 'result', session_id: 'sess-abc', result: 'Hello world', is_error: false })
    ]);

    const messages: AgentMessage[] = [];
    const handle = new ClaudeBackend(script).run(opts(), (m) => messages.push(m));
    const result = await handle.result;

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Hello world');
    expect(result.sessionId).toBe('sess-abc');
    expect(messages.filter((m) => m.type === 'text').map((m) => m.content)).toEqual(['Hello ', 'world']);
  });

  test('a result error frame overrides a zero exit code (no fake success)', async () => {
    const script = await fakeClaude([
      JSON.stringify({ type: 'result', session_id: 's', result: 'boom', is_error: true })
    ]);
    const handle = new ClaudeBackend(script).run(opts(), () => {});
    const result = await handle.result;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
  });

  test('detect is false for a missing executable', async () => {
    expect(await new ClaudeBackend('claude-not-installed-xyz').detect()).toBe(false);
  });
});

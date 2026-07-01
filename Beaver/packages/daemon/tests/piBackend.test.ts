import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PiBackend,
  PiTextSanitizer,
  buildPiArgs,
  parsePiEvent,
  splitPiModel,
  type AgentBackendOptions,
  type AgentMessage
} from '../src/agent/backend';

describe('PiTextSanitizer', () => {
  test('strips inline tool-call markup from text', () => {
    const s = new PiTextSanitizer();
    let out = s.drain('Hello call:Bash{"command":"ls"}<tool_call|> world');
    out += s.flush();
    expect(out).toBe('Hello  world');
  });

  test('holds a markup span split across deltas', () => {
    const s = new PiTextSanitizer();
    let out = s.drain('Hi call:Ba');
    out += s.drain('sh{"x":1}<tool_call|> done');
    out += s.flush();
    expect(out).toBe('Hi  done');
  });

  test('passes clean text straight through', () => {
    const s = new PiTextSanitizer();
    let out = s.drain('just plain ');
    out += s.drain('text');
    out += s.flush();
    expect(out).toBe('just plain text');
  });
});

describe('parsePiEvent', () => {
  test('maps the event stream to normalized kinds', () => {
    expect(parsePiEvent(JSON.stringify({ type: 'agent_start' })).kind).toBe('status');
    expect(parsePiEvent('not json').kind).toBe('ignore');
    expect(
      parsePiEvent(
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
      )
    ).toEqual({ kind: 'text_delta', delta: 'x' });
    expect(
      parsePiEvent(
        JSON.stringify({ type: 'tool_execution_start', toolName: 'Bash', toolCallId: 't1', args: { command: 'ls' } })
      )
    ).toEqual({ kind: 'tool_use', tool: 'Bash', callId: 't1', input: { command: 'ls' } });
    expect(parsePiEvent(JSON.stringify({ type: 'tool_execution_end', toolCallId: 't1', result: 'ok' }))).toEqual({
      kind: 'tool_result',
      callId: 't1',
      output: 'ok'
    });
    expect(parsePiEvent(JSON.stringify({ type: 'error', message: 'boom' }))).toEqual({ kind: 'error', message: 'boom' });
    expect(parsePiEvent(JSON.stringify({ type: 'auto_retry_end', success: false, finalError: 'gave up' }))).toEqual({
      kind: 'retry_failed',
      message: 'gave up'
    });
    expect(parsePiEvent(JSON.stringify({ type: 'auto_retry_end', success: true })).kind).toBe('ignore');
  });
});

describe('buildPiArgs', () => {
  test('prompt is the trailing positional arg and session is passed', () => {
    const args = buildPiArgs(
      { cwd: '/w', promptText: 'the prompt', stdoutPath: '/o', stderrPath: '/e', model: 'anthropic/claude-opus-4-8' },
      '/sess/abc.jsonl'
    );
    expect(args.slice(0, 4)).toEqual(['-p', '--mode', 'json', '--session']);
    expect(args).toEqual(expect.arrayContaining(['--provider', 'anthropic', '--model', 'claude-opus-4-8']));
    expect(args[args.length - 1]).toBe('the prompt');
  });

  test('splitPiModel splits provider/model and passes bare model through', () => {
    expect(splitPiModel('anthropic/claude-opus-4-8')).toEqual(['anthropic', 'claude-opus-4-8']);
    expect(splitPiModel('gpt-5')).toEqual(['', 'gpt-5']);
  });
});

describe('PiBackend (fake CLI)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join('/tmp', `bv-pi-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function fakePi(events: object[]): Promise<string> {
    const script = path.join(dir, 'fake-pi.sh');
    const emits = events.map((e) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(e))}`).join('\n');
    await fs.writeFile(script, `#!/usr/bin/env bash\n${emits}\nexit 0\n`, { mode: 0o755 });
    return script;
  }

  function opts(overrides: Partial<AgentBackendOptions> = {}): AgentBackendOptions {
    return {
      cwd: dir,
      promptText: 'do the thing',
      stdoutPath: path.join(dir, 'stdout.log'),
      stderrPath: path.join(dir, 'stderr.log'),
      ...overrides
    };
  }

  test('parses the event stream into text, tool calls, and a completed result', async () => {
    const script = await fakePi([
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'Bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 't1', result: 'file.txt' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }
    ]);

    const messages: AgentMessage[] = [];
    const backend = new PiBackend(script, undefined, path.join(dir, 'sessions'));
    const handle = backend.run(opts(), (m) => messages.push(m));
    const result = await handle.result;

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Hello done');
    expect(result.sessionId).toContain('sessions');
    expect(messages.some((m) => m.type === 'tool_use' && m.tool === 'Bash')).toBe(true);
    expect(messages.some((m) => m.type === 'tool_result' && m.output === 'file.txt')).toBe(true);
  });

  test('an error event fails the run even on a zero exit', async () => {
    const script = await fakePi([{ type: 'error', message: 'kaboom' }]);
    const backend = new PiBackend(script, undefined, path.join(dir, 'sessions'));
    const result = await backend.run(opts(), () => {}).result;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('kaboom');
  });

  test('reuses a provided resume session path as the session id', async () => {
    const script = await fakePi([{ type: 'agent_start' }]);
    const resume = path.join(dir, 'sessions', 'resume-me.jsonl');
    const backend = new PiBackend(script, undefined, path.join(dir, 'sessions'));
    const result = await backend.run(opts({ resumeSessionId: resume }), () => {}).result;
    expect(result.sessionId).toBe(resume);
  });
});

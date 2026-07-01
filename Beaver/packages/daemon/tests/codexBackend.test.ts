import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CodexBackend,
  CodexRpcClient,
  buildServerApproval,
  extractThreadId,
  mapItemNotification,
  mapLegacyEvent,
  type AgentBackendOptions,
  type AgentMessage,
  type CodexEvent
} from '../src/agent/backend';

describe('codex protocol mapping', () => {
  test('legacy codex/event types map to normalized events', () => {
    expect(mapLegacyEvent({ type: 'task_started' })).toEqual([{ kind: 'status' }]);
    expect(mapLegacyEvent({ type: 'agent_message', message: 'hi' })).toEqual([{ kind: 'text', text: 'hi' }]);
    expect(mapLegacyEvent({ type: 'exec_command_begin', call_id: 'c1', command: 'ls' })).toEqual([
      { kind: 'tool_use', tool: 'exec_command', callId: 'c1', input: { command: 'ls' } }
    ]);
    expect(mapLegacyEvent({ type: 'task_complete' })).toEqual([{ kind: 'turn_done', aborted: false }]);
    expect(mapLegacyEvent({ type: 'turn_aborted' })).toEqual([{ kind: 'turn_done', aborted: true }]);
  });

  test('raw item/completed agentMessage with final_answer emits text and turn_done', () => {
    const events = mapItemNotification('item/completed', {
      item: { type: 'agentMessage', text: 'answer', phase: 'final_answer' }
    });
    expect(events).toEqual([
      { kind: 'text', text: 'answer' },
      { kind: 'turn_done', aborted: false }
    ]);
  });

  test('server requests auto-approve; unknown ones return a method-not-found error', () => {
    expect(buildServerApproval('item/commandExecution/requestApproval', {})).toEqual({ result: { decision: 'accept' } });
    expect(buildServerApproval('item/permissions/requestApproval', { permissions: { network: { full: true }, x: 1 } })).toEqual({
      result: { permissions: { network: { full: true } }, scope: 'turn' }
    });
    const unknown = buildServerApproval('mystery/method', {});
    expect('error' in unknown && unknown.error.code).toBe(-32601);
  });

  test('extractThreadId reads thread.id', () => {
    expect(extractThreadId({ thread: { id: 'thr-9' } })).toBe('thr-9');
    expect(extractThreadId({})).toBe('');
  });
});

describe('CodexRpcClient', () => {
  test('correlates responses and auto-approves server requests', async () => {
    const written: string[] = [];
    const client = new CodexRpcClient((data) => written.push(data.trim()));

    const pending = client.request('initialize', { x: 1 });
    const sent = JSON.parse(written[0] ?? '');
    expect(sent).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    expect(await pending).toEqual({ ok: true });

    // A server request (has id + method) must be auto-approved.
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'item/commandExecution/requestApproval', params: {} }));
    const reply = JSON.parse(written[written.length - 1] ?? '');
    expect(reply).toEqual({ jsonrpc: '2.0', id: 7, result: { decision: 'accept' } });
  });

  test('emits events from raw turn notifications', () => {
    const events: CodexEvent[] = [];
    const client = new CodexRpcClient(() => {});
    client.onEvent = (e) => events.push(e);
    client.setThreadId('thr-1');
    client.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr-1', turn: { id: 't1' } } }));
    client.handleLine(
      JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 't1', status: 'completed' } } })
    );
    expect(events).toEqual([{ kind: 'status' }, { kind: 'turn_done', aborted: false }]);
  });

  test('failAll rejects in-flight requests', async () => {
    const client = new CodexRpcClient(() => {});
    const pending = client.request('turn/start', {});
    client.failAll(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
  });
});

describe('CodexBackend (fake app-server)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join('/tmp', `bv-codex-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function fakeCodex(turnBody: string): Promise<string> {
    const script = path.join(dir, 'fake-codex.mjs');
    const src = `#!/usr/bin/env bun
let buf = '';
let threadId = 'thr-1';
function send(o){ process.stdout.write(JSON.stringify(o) + '\\n'); }
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); }
    else if (m.method === 'thread/start') { send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: threadId } } }); }
    else if (m.method === 'thread/resume') { threadId = m.params.threadId; send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: threadId } } }); }
    else if (m.method === 'turn/start') {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
      ${turnBody}
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
    await fs.writeFile(script, src, { mode: 0o755 });
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

  test('drives a full turn and reports completed with output and thread id', async () => {
    const script = await fakeCodex(`
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: 't1' } } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: 'Hello from codex', phase: 'final_answer' } } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: 't1', status: 'completed' } } });
    `);

    const messages: AgentMessage[] = [];
    const handle = new CodexBackend(script).run(opts(), (m) => messages.push(m));
    const result = await handle.result;

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Hello from codex');
    expect(result.sessionId).toBe('thr-1');
    expect(messages.some((m) => m.type === 'status')).toBe(true);
  });

  test('a failed turn is surfaced as failed with the turn error', async () => {
    const script = await fakeCodex(`
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: 't1', status: 'failed', error: { message: 'model refused' } } } });
    `);
    const result = await new CodexBackend(script).run(opts(), () => {}).result;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('model refused');
  });

  test('a process exit before the turn completes is a failure, not a fake success', async () => {
    const script = await fakeCodex(`
      // respond to turn/start but never complete the turn, then exit
      process.exit(0);
    `);
    const result = await new CodexBackend(script).run(opts(), () => {}).result;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('before completing the turn');
  });

  test('resumes a provided session id', async () => {
    const script = await fakeCodex(`
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: 't1', status: 'completed' } } });
    `);
    const result = await new CodexBackend(script).run(opts({ resumeSessionId: 'thr-resumed' }), () => {}).result;
    expect(result.status).toBe('completed');
    expect(result.sessionId).toBe('thr-resumed');
  });
});

/**
 * Pure interpretation of Codex `app-server` JSON-RPC notifications and
 * server-requests. The transport/lifecycle live in codexRpc.ts / codexBackend.ts;
 * this holds the message-shape semantics so they are unit-testable. Ported from
 * the Multica reference, trimmed to the event set Beaver consumes.
 *
 * Deferred vs the reference (handled at the orchestrator layer or not yet
 * needed): semantic-inactivity / first-turn timers, OTEL-flush grace shutdown,
 * session-JSONL usage scanning, managed MCP config.toml, reasoning-effort and
 * thread-name injection.
 */

export type CodexEvent =
  | { kind: 'status' }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; tool: string; callId?: string; input?: Record<string, unknown> }
  | { kind: 'tool_result'; tool: string; callId?: string; output: string }
  | { kind: 'turn_done'; aborted: boolean }
  | { kind: 'turn_error'; message: string };

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as AnyRecord) : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function extractThreadId(result: unknown): string {
  return extractNested(result, 'thread', 'id');
}

export function extractNested(obj: unknown, ...keys: string[]): string {
  let current: unknown = obj;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) {
      return '';
    }
    current = record[key];
  }
  return asString(current);
}

/** Auto-approve reply for a Codex server-request (no human in daemon mode). */
export function buildServerApproval(
  method: string,
  params: unknown
): { result: unknown } | { error: { code: number; message: string } } {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'accept' } };
    case 'item/permissions/requestApproval':
      return { result: { permissions: grantedPermissions(params), scope: 'turn' } };
    case 'mcpServer/elicitation/request':
      return { result: { action: 'accept', content: null, _meta: null } };
    default:
      return { error: { code: -32601, message: `unsupported codex app-server request: ${method}` } };
  }
}

function grantedPermissions(params: unknown): AnyRecord {
  const permissions = asRecord(asRecord(params)?.permissions) ?? {};
  const granted: AnyRecord = {};
  for (const key of ['network', 'fileSystem']) {
    if (permissions[key] != null) {
      granted[key] = permissions[key];
    }
  }
  return granted;
}

/** Legacy `codex/event` notifications carry the event under params.msg. */
export function mapLegacyEvent(msg: unknown): CodexEvent[] {
  const record = asRecord(msg);
  if (!record) {
    return [];
  }
  const type = asString(record.type);
  const callId = asString(record.call_id);
  switch (type) {
    case 'task_started':
      return [{ kind: 'status' }];
    case 'agent_message': {
      const text = asString(record.message);
      return text ? [{ kind: 'text', text }] : [];
    }
    case 'exec_command_begin':
      return [{ kind: 'tool_use', tool: 'exec_command', callId, input: { command: asString(record.command) } }];
    case 'exec_command_end':
      return [{ kind: 'tool_result', tool: 'exec_command', callId, output: asString(record.output) }];
    case 'patch_apply_begin':
      return [{ kind: 'tool_use', tool: 'patch_apply', callId }];
    case 'patch_apply_end':
      return [{ kind: 'tool_result', tool: 'patch_apply', callId, output: '' }];
    case 'task_complete':
      return [{ kind: 'turn_done', aborted: false }];
    case 'turn_aborted':
      return [{ kind: 'turn_done', aborted: true }];
    default:
      return [];
  }
}

/** Raw v2 `item/*` notifications carry the item under params.item. */
export function mapItemNotification(method: string, params: unknown): CodexEvent[] {
  const item = asRecord(asRecord(params)?.item);
  if (!item) {
    return [];
  }
  const itemType = asString(item.type);
  const itemId = asString(item.id);

  if (method === 'item/started' && itemType === 'commandExecution') {
    return [{ kind: 'tool_use', tool: 'exec_command', callId: itemId, input: { command: asString(item.command) } }];
  }
  if (method === 'item/completed' && itemType === 'commandExecution') {
    return [{ kind: 'tool_result', tool: 'exec_command', callId: itemId, output: asString(item.aggregatedOutput) }];
  }
  if (method === 'item/started' && itemType === 'fileChange') {
    return [{ kind: 'tool_use', tool: 'patch_apply', callId: itemId }];
  }
  if (method === 'item/completed' && itemType === 'fileChange') {
    return [{ kind: 'tool_result', tool: 'patch_apply', callId: itemId, output: '' }];
  }
  if (method === 'item/completed' && itemType === 'agentMessage') {
    const events: CodexEvent[] = [];
    const text = asString(item.text);
    if (text) {
      events.push({ kind: 'text', text });
    }
    if (asString(item.phase) === 'final_answer') {
      events.push({ kind: 'turn_done', aborted: false });
    }
    return events;
  }
  return [];
}

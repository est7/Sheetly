import {
  buildServerApproval,
  extractNested,
  mapItemNotification,
  mapLegacyEvent,
  type CodexEvent
} from './codexProtocol';

type PendingRpc = { resolve: (result: unknown) => void; reject: (error: Error) => void; method: string };

/**
 * Minimal JSON-RPC 2.0 client for the Codex app-server over newline-delimited
 * JSON. It correlates request/response by id, auto-approves server-requests
 * (exec / patch / permissions / elicitation), and translates notifications into
 * normalized CodexEvents via onEvent. Transport is injected as `write` so the
 * client is testable without a real process; codexBackend wires it to the
 * child's stdin.
 */
export class CodexRpcClient {
  private nextId = 0;
  private readonly pending = new Map<number, PendingRpc>();
  private threadId = '';
  private turnStarted = false;
  private exited = false;

  /** Set by the owner to receive normalized events. */
  onEvent: (event: CodexEvent) => void = () => {};

  constructor(private readonly write: (data: string) => void) {}

  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error('codex process exited'));
    }
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  /** Reject every in-flight request; called when the process dies. */
  failAll(error: Error): void {
    this.exited = true;
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  handleLine(line: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const hasId = 'id' in raw && typeof raw.id === 'number';
    if (hasId && ('result' in raw || 'error' in raw)) {
      this.handleResponse(raw.id as number, raw);
      return;
    }
    if (hasId && 'method' in raw) {
      this.handleServerRequest(raw.id as number, String(raw.method), raw.params);
      return;
    }
    if ('method' in raw) {
      this.handleNotification(String(raw.method), raw.params);
    }
  }

  private handleResponse(id: number, raw: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if ('error' in raw) {
      const err = raw.error as { code?: number; message?: string } | undefined;
      pending.reject(new Error(`${pending.method}: ${err?.message ?? 'error'} (code=${err?.code ?? 0})`));
    } else {
      pending.resolve(raw.result);
    }
  }

  private handleServerRequest(id: number, method: string, params: unknown): void {
    const reply = buildServerApproval(method, params);
    if ('error' in reply) {
      this.emit({ kind: 'turn_error', message: reply.error.message });
      this.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: reply.error })}\n`);
    } else {
      this.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: reply.result })}\n`);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    // Legacy codex/event: the real event is nested under params.msg.
    if (method === 'codex/event' || method.startsWith('codex/event/')) {
      const msg = (params as { msg?: unknown } | undefined)?.msg;
      for (const event of mapLegacyEvent(msg)) {
        this.emit(event);
      }
      return;
    }

    // Raw v2: drop notifications from other multiplexed threads once ours is known.
    const record = (params ?? {}) as Record<string, unknown>;
    const threadId = typeof record.threadId === 'string' ? record.threadId : '';
    if (this.threadId && threadId && threadId !== this.threadId) {
      return;
    }

    switch (method) {
      case 'turn/started':
        this.turnStarted = true;
        this.emit({ kind: 'status' });
        return;
      case 'turn/completed': {
        const status = extractNested(params, 'turn', 'status');
        const aborted = ['cancelled', 'canceled', 'aborted', 'interrupted'].includes(status);
        if (status === 'failed') {
          this.emit({ kind: 'turn_error', message: extractNested(params, 'turn', 'error', 'message') || 'codex turn failed' });
        }
        this.emit({ kind: 'turn_done', aborted });
        return;
      }
      case 'error': {
        const willRetry = record.willRetry === true;
        const message = extractNested(params, 'error', 'message') || extractNested(params, 'message');
        if (message && !willRetry) {
          this.emit({ kind: 'turn_error', message });
          this.emit({ kind: 'turn_done', aborted: false });
        }
        return;
      }
      case 'thread/status/changed':
        if (extractNested(params, 'status', 'type') === 'idle' && this.turnStarted) {
          this.emit({ kind: 'turn_done', aborted: false });
        }
        return;
      default:
        if (method.startsWith('item/')) {
          for (const event of mapItemNotification(method, params)) {
            if (event.kind === 'status') {
              this.turnStarted = true;
            }
            this.emit(event);
          }
        }
    }
  }

  private emit(event: CodexEvent): void {
    if (event.kind === 'status') {
      this.turnStarted = true;
    }
    this.onEvent(event);
  }
}

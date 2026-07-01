/**
 * Pi CLI (`pi -p --mode json`) stdout event interpretation. Pi streams one JSON
 * event per line AND leaks structured tool-call markup (`call:Name{...}`,
 * `response:...`, `<|token>` control tokens) inline into text deltas. This
 * module ports Multica's proven sanitizer so user-visible text never carries
 * that markup, plus a pure per-event parser. Split from the adapter (process /
 * session concerns) so the fiddly string logic is independently testable.
 */

const PI_CONTROL_TOKEN_RE = /<\|[A-Za-z0-9_-]+>[A-Za-z0-9_-]*|<[A-Za-z0-9_-]+\|>/g;
const MARKUP_PREFIXES = ['call:', 'response:'];
const TOOL_CALL_SUFFIX = '<tool_call|>';
const QUOTE_MARKER = '<|"|>';

function stripControlTokens(s: string): string {
  return s.replace(PI_CONTROL_TOKEN_RE, '');
}

function isPiToolNameChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

/** Earliest `call:`/`response:` at or after `from`; [-1, 0] when none. */
function nextMarkupPrefix(s: string, from: number): [number, number] {
  let best = -1;
  let bestLen = 0;
  for (const prefix of MARKUP_PREFIXES) {
    const i = s.indexOf(prefix, from);
    if (i >= 0 && (best === -1 || i < best)) {
      best = i;
      bestLen = prefix.length;
    }
  }
  return [best, bestLen];
}

/** From the byte after a prefix, consume `name{...}` (brace-matched, honoring
 * the `<|"|>` quote marker) plus an optional trailing `<tool_call|>`. */
function scanMarkupEnd(s: string, start: number): [number, boolean] {
  let i = start;
  const nameStart = i;
  while (i < s.length && isPiToolNameChar(s.charAt(i))) {
    i++;
  }
  if (i === nameStart || i >= s.length || s[i] !== '{') {
    return [0, false];
  }
  let depth = 0;
  let inQuote = false;
  while (i < s.length) {
    if (s.startsWith(QUOTE_MARKER, i)) {
      inQuote = !inQuote;
      i += QUOTE_MARKER.length;
      continue;
    }
    if (!inQuote) {
      if (s[i] === '{') {
        depth++;
      } else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          if (s.startsWith(TOOL_CALL_SUFFIX, i)) {
            i += TOOL_CALL_SUFFIX.length;
          }
          return [i, true];
        }
      }
    }
    i++;
  }
  return [0, false];
}

function looksLikeControlTokenPrefix(s: string): boolean {
  if (s.length === 0 || s[0] !== '<' || s.length > 64) {
    return false;
  }
  for (let i = 1; i < s.length; i++) {
    if (!/[A-Za-z0-9_\-|>]/.test(s.charAt(i))) {
      return false;
    }
  }
  return true;
}

/** Length safe to emit now: hold back a trailing partial markup prefix or a
 * partial `<...` control token that a later delta may complete. */
function safeEmitLen(s: string): number {
  let hold = 0;
  for (const prefix of MARKUP_PREFIXES) {
    for (let n = 1; n < prefix.length && n <= s.length; n++) {
      if (s.endsWith(prefix.slice(0, n)) && n > hold) {
        hold = n;
      }
    }
  }
  const lt = s.lastIndexOf('<');
  if (lt >= 0 && looksLikeControlTokenPrefix(s.slice(lt)) && s.length - lt > hold) {
    hold = s.length - lt;
  }
  return s.length - hold;
}

/** Emit the sanitized safe portion of `s`; return [emit, pending] where pending
 * is held for the next delta (a partial prefix or an unterminated markup span). */
function drainSanitizedText(s: string): [string, string] {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const [start, prefixLen] = nextMarkupPrefix(s, i);
    if (start === -1) {
      const safeLen = safeEmitLen(s.slice(i));
      out += s.slice(i, i + safeLen);
      return [stripControlTokens(out), s.slice(i + safeLen)];
    }
    out += s.slice(i, start);
    const [end, ok] = scanMarkupEnd(s, start + prefixLen);
    if (!ok) {
      return [stripControlTokens(out), s.slice(start)];
    }
    i = end;
  }
  return [stripControlTokens(out), ''];
}

/** Buffers text deltas across events, emitting only markup-free text and
 * holding partial markup until it completes (or the stream flushes). */
export class PiTextSanitizer {
  private buffer = '';

  drain(delta: string): string {
    this.buffer += delta;
    const [emit, pending] = drainSanitizedText(this.buffer);
    this.buffer = pending;
    return emit;
  }

  flush(): string {
    const s = this.buffer;
    this.buffer = '';
    const [emit, pending] = drainSanitizedText(s);
    return emit + stripControlTokens(pending);
  }
}

export type PiEvent =
  | { kind: 'status' }
  | { kind: 'text_delta'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool_use'; tool?: string; callId?: string; input?: Record<string, unknown> }
  | { kind: 'tool_result'; callId?: string; output: string }
  | { kind: 'error'; message: string }
  | { kind: 'retry_failed'; message: string }
  | { kind: 'ignore' };

type RawPiEvent = {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  message?: unknown;
  success?: boolean;
  finalError?: string;
};

export function parsePiEvent(line: string): PiEvent {
  const trimmed = line.trim();
  if (trimmed === '') {
    return { kind: 'ignore' };
  }
  let evt: RawPiEvent;
  try {
    evt = JSON.parse(trimmed) as RawPiEvent;
  } catch {
    return { kind: 'ignore' };
  }

  switch (evt.type) {
    case 'agent_start':
      return { kind: 'status' };
    case 'message_update': {
      const inner = evt.assistantMessageEvent;
      if (!inner) {
        return { kind: 'ignore' };
      }
      if (inner.type === 'text_delta') {
        return { kind: 'text_delta', delta: inner.delta ?? '' };
      }
      if (inner.type === 'thinking_delta') {
        return { kind: 'thinking', delta: inner.delta ?? '' };
      }
      return { kind: 'ignore' };
    }
    case 'tool_execution_start':
      return { kind: 'tool_use', tool: evt.toolName, callId: evt.toolCallId, input: evt.args };
    case 'tool_execution_end':
      return { kind: 'tool_result', callId: evt.toolCallId, output: decodeResult(evt.result) };
    case 'error':
      return { kind: 'error', message: decodeString(evt.message) };
    case 'auto_retry_end':
      return evt.success === false
        ? { kind: 'retry_failed', message: evt.finalError || 'pi exhausted automatic retries' }
        : { kind: 'ignore' };
    default:
      return { kind: 'ignore' };
  }
}

function decodeResult(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function decodeString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return JSON.stringify(value);
}

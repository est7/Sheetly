import type { AgentMessage } from './types';

/**
 * Pure interpretation of one Claude Code `--output-format stream-json` line.
 * The adapter owns process/stdin concerns; this owns protocol semantics so it
 * can be tested against canned frames. Non-JSON lines (startup banner) and
 * unknown types yield an empty outcome rather than throwing.
 */
export type ClaudeParseOutcome = {
  messages: AgentMessage[];
  sessionId?: string;
  /** Final assistant text from a `result` frame; overrides streamed text. */
  finalText?: string;
  /** Present when `result.is_error` — the run failed with this message. */
  finalError?: string;
  /** True once a `result` frame is seen; the adapter closes stdin then. */
  done?: boolean;
  /** A `control_response` line to write back to stdin (auto-approve). */
  controlResponse?: string;
};

type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
};

type SdkMessage = {
  type?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  request_id?: string;
  request?: { input?: Record<string, unknown> };
  log?: { level?: string; message?: string };
};

const EMPTY: ClaudeParseOutcome = { messages: [] };

export function parseClaudeLine(line: string): ClaudeParseOutcome {
  const trimmed = line.trim();
  if (trimmed === '') {
    return EMPTY;
  }
  let msg: SdkMessage;
  try {
    msg = JSON.parse(trimmed) as SdkMessage;
  } catch {
    return EMPTY; // banner / non-JSON noise
  }

  switch (msg.type) {
    case 'assistant':
      return { messages: assistantMessages(msg.message?.content ?? []) };
    case 'user':
      return { messages: toolResultMessages(msg.message?.content ?? []) };
    case 'system':
      return {
        messages: [{ type: 'status', status: 'running', sessionId: msg.session_id }],
        sessionId: msg.session_id
      };
    case 'result':
      return {
        messages: [],
        sessionId: msg.session_id,
        finalText: msg.result,
        finalError: msg.is_error ? (msg.result ?? 'agent reported an error') : undefined,
        done: true
      };
    case 'log':
      return { messages: [{ type: 'log', content: msg.log?.message, status: msg.log?.level }] };
    case 'control_request':
      return { messages: [], controlResponse: buildControlResponse(msg) };
    default:
      return EMPTY;
  }
}

function assistantMessages(blocks: ContentBlock[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      out.push({ type: 'text', content: block.text });
    } else if (block.type === 'thinking' && block.text) {
      out.push({ type: 'thinking', content: block.text });
    } else if (block.type === 'tool_use') {
      out.push({ type: 'tool_use', tool: block.name, callId: block.id, input: block.input });
    }
  }
  return out;
}

function toolResultMessages(blocks: ContentBlock[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      out.push({ type: 'tool_result', callId: block.tool_use_id, output: stringifyContent(block.content) });
    }
  }
  return out;
}

function stringifyContent(content: unknown): string {
  if (content === undefined || content === null) {
    return '';
  }
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Auto-approve a tool-use permission request. Autonomous runs have no UI to
 * prompt in, so we allow with the input unchanged, forcing any background-launch
 * flag to foreground (Beaver-managed runs must stay in the foreground).
 */
function buildControlResponse(msg: SdkMessage): string {
  const input = { ...(msg.request?.input ?? {}) } as Record<string, unknown>;
  if (input.run_in_background === true) {
    input.run_in_background = false;
  }
  const response = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: msg.request_id,
      response: { behavior: 'allow', updatedInput: input }
    }
  };
  return `${JSON.stringify(response)}\n`;
}

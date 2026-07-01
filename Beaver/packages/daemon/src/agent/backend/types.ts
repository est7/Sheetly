import type { TemplateVariables } from '@beaver/core';

/** Normalized event emitted by an agent backend (mirrors Multica/happy-cli). */
export type AgentMessageType = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'log';

export type AgentMessage = {
  type: AgentMessageType;
  content?: string;
  tool?: string;
  callId?: string;
  input?: Record<string, unknown>;
  output?: string;
  status?: string;
  sessionId?: string;
};

export type AgentBackendStatus = 'completed' | 'failed' | 'blocked' | 'stopped';

export type AgentBackendResult = {
  status: AgentBackendStatus;
  output: string;
  error?: string;
  sessionId?: string;
  exitCode: number | null;
};

export type AgentBackendOptions = {
  cwd: string;
  promptText: string;
  promptPath?: string;
  model?: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  extraArgs?: string[];
  blockingExitCodes?: number[];
  /** Override the CLI binary path (Multica's ExecutablePath). */
  executablePath?: string;
  stdoutPath: string;
  stderrPath: string;
  variables?: TemplateVariables;
};

export type AgentBackendHandle = {
  pid?: number;
  result: Promise<AgentBackendResult>;
  stop: () => void;
};

/**
 * A provider adapter: it owns HOW one agent CLI is invoked (argv, prompt
 * delivery, its JSON event protocol) and normalizes the agent's output into
 * `AgentMessage` events + a final `AgentBackendResult`. Adding an agent = adding
 * a backend. `detect` reports whether the CLI is installed.
 */
export interface AgentBackend {
  readonly id: string;
  detect(env?: NodeJS.ProcessEnv): Promise<boolean>;
  run(options: AgentBackendOptions, onMessage: (message: AgentMessage) => void): AgentBackendHandle;
}

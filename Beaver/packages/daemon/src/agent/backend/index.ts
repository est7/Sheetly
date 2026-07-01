export type {
  AgentBackend,
  AgentBackendHandle,
  AgentBackendOptions,
  AgentBackendResult,
  AgentBackendStatus,
  AgentMessage,
  AgentMessageType
} from './types';
export { GenericBackend } from './genericBackend';
export { ClaudeBackend, buildClaudeArgs } from './claudeBackend';
export { parseClaudeLine, type ClaudeParseOutcome } from './claudeStreamJson';
export { buildBackendRegistry, resolveNamedBackend } from './registry';
export { commandExists } from './which';

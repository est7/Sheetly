import type { AgentProvider } from '@beaver/core';
import { AgentRunner } from '../agentRunner';
import { ClaudeBackend } from './claudeBackend';
import { CodexBackend } from './codexBackend';
import { GenericBackend } from './genericBackend';
import { PiBackend } from './piBackend';
import type { AgentBackend } from './types';

export type BackendProfile = {
  provider?: AgentProvider;
  command: string;
  args: string[];
};

/**
 * Build the agent backend for a profile. A `provider` selects the structured
 * adapter (driving that CLI's native protocol) with `command` as the
 * executable; no provider falls back to the unstructured GenericBackend over
 * the raw `{command, args}`. All backends share the injected AgentRunner so
 * process-group signalling / stop semantics stay uniform.
 */
export function createBackend(profile: BackendProfile, runner: AgentRunner): AgentBackend {
  switch (profile.provider) {
    case 'claude-code':
      return new ClaudeBackend(profile.command, runner);
    case 'pi':
      return new PiBackend(profile.command, runner);
    case 'codex':
      return new CodexBackend(profile.command, runner);
    default:
      return new GenericBackend(profile.command, profile.args, runner);
  }
}

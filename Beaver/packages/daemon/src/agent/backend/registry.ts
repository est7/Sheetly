import { BeaverError } from '@beaver/core';
import type { AgentBackend } from './types';

/**
 * Registry of named provider backends (claude-code / codex / pi are registered
 * as they land). A raw `{command, args}` profile does not use this registry —
 * the caller constructs a GenericBackend directly.
 */
export function buildBackendRegistry(providers: AgentBackend[] = []): Map<string, AgentBackend> {
  const registry = new Map<string, AgentBackend>();
  for (const provider of providers) {
    registry.set(provider.id, provider);
  }
  return registry;
}

export function resolveNamedBackend(registry: Map<string, AgentBackend>, id: string): AgentBackend {
  const backend = registry.get(id);
  if (!backend) {
    throw new BeaverError('NOT_IMPLEMENTED', { feature: `agent provider: ${id}` });
  }
  return backend;
}

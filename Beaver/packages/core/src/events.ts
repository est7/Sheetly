import { z } from 'zod';

/**
 * Append-only run event types. Stable English identifiers; never localized.
 * Phase events (`worktree.created`, `agent.stdout`, ...) are distinct from the
 * run status axis in `domain.ts`.
 */
export const RUN_EVENT_TYPES = [
  'run.created',
  'run.status_changed',
  'run.error',
  'workspace.prepared',
  'worktree.created',
  'submodules.initialized',
  'files.materialized',
  'agent.started',
  'agent.stdout',
  'agent.stderr',
  'agent.exited',
  'verifier.started',
  'verifier.stdout',
  'verifier.stderr',
  'verifier.exited',
  'handoff.created',
  'tool.started',
  'tool.stdout',
  'tool.stderr',
  'tool.exited'
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.enum(RUN_EVENT_TYPES),
  timestamp: z.string().min(1),
  payload: z.record(z.unknown())
});

export type RunEvent = z.infer<typeof RunEventSchema>;

import type { RunStatus } from './domain';
import { BeaverError } from './errors';

/**
 * The single authoritative run state machine. Side-effecting code must ask this
 * module before changing persistent state; no module should encode transitions
 * inline.
 *
 * Vocabulary is trimmed to states with a real producer today (D3). Roadmap
 * states (planning/plan_ready/reviewing/fixing/pr_opened and the remaining
 * block reasons) are added when their phase lands — a cheap append, since
 * status persists as opaque TEXT.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  discovered: ['claimed', 'aborted'],
  claimed: ['preparing_workspace', 'blocked_permission', 'blocked_infra', 'aborted'],
  preparing_workspace: ['implementing', 'blocked_infra', 'aborted'],
  implementing: ['verifying', 'blocked_agent_failed', 'blocked_infra', 'aborted'],
  verifying: ['pr_ready', 'blocked_tests', 'blocked_infra', 'aborted'],
  pr_ready: ['done', 'aborted'],
  done: [],
  blocked_permission: ['claimed', 'aborted'],
  blocked_agent_failed: ['implementing', 'aborted'],
  blocked_tests: ['implementing', 'aborted'],
  blocked_infra: ['claimed', 'preparing_workspace', 'implementing', 'verifying', 'aborted'],
  aborted: []
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new BeaverError('ILLEGAL_TRANSITION', { from, to });
  }
}

export function allowedTransitions(from: RunStatus): readonly RunStatus[] {
  return TRANSITIONS[from];
}

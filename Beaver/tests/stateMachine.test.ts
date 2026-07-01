import { describe, expect, it } from 'vitest';
import {
  BeaverError,
  RUN_STATUSES,
  allowedTransitions,
  assertRunTransition,
  canTransitionRun,
  type RunStatus
} from '@beaver/core';

describe('run state machine (trimmed MVP vocabulary, D3)', () => {
  it('allows the MVP happy path', () => {
    const path: RunStatus[] = [
      'discovered',
      'claimed',
      'preparing_workspace',
      'implementing',
      'verifying',
      'pr_ready',
      'done'
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionRun(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows a blocked-tests retry back into implementing', () => {
    expect(canTransitionRun('verifying', 'blocked_tests')).toBe(true);
    expect(canTransitionRun('blocked_tests', 'implementing')).toBe(true);
  });

  it('rejects illegal jumps with a localizable BeaverError', () => {
    expect(canTransitionRun('discovered', 'done')).toBe(false);
    try {
      assertRunTransition('done', 'implementing');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BeaverError);
      expect((error as BeaverError).code).toBe('ILLEGAL_TRANSITION');
      expect((error as BeaverError).params).toMatchObject({ from: 'done', to: 'implementing' });
    }
  });

  it('has no roadmap states without a producer', () => {
    expect(RUN_STATUSES).not.toContain('planning');
    expect(RUN_STATUSES).not.toContain('fixing');
    expect(RUN_STATUSES).not.toContain('pr_opened');
  });

  it('treats done and aborted as terminal and defines transitions for every status', () => {
    expect(allowedTransitions('done')).toHaveLength(0);
    expect(allowedTransitions('aborted')).toHaveLength(0);
    for (const status of RUN_STATUSES) {
      expect(() => allowedTransitions(status)).not.toThrow();
    }
  });
});

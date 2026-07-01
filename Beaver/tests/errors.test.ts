import { describe, expect, it } from 'vitest';
import {
  BEAVER_ERROR_CODES,
  BeaverError,
  EXIT,
  exitCodeForError,
  isApiErrorBody,
  type BeaverErrorCode,
  type ExitCode
} from '@beaver/core';

describe('BeaverError', () => {
  it('serializes to a stable wire body', () => {
    const body = new BeaverError('REPO_INVALID', { repoPath: '/x' }).toBody();
    expect(body).toEqual({ error: { code: 'REPO_INVALID', params: { repoPath: '/x' } } });
    expect(isApiErrorBody(body)).toBe(true);
  });

  it('rejects non-error bodies', () => {
    expect(isApiErrorBody({ ok: true })).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody({ error: { code: 'NOPE' } })).toBe(false);
  });

  it('maps every error code to its EXACT stable exit code (D14 contract)', () => {
    // Independently encoded expectation: a remap in the implementation (e.g.
    // GIT_FAILED -> CONFIG) must fail this test, not slip through a membership
    // check. Adding a new code without a mapping here also fails to compile.
    const expected: Record<BeaverErrorCode, ExitCode> = {
      BAD_REQUEST: EXIT.FAILURE,
      NOT_FOUND: EXIT.FAILURE,
      CONFIG_INVALID: EXIT.CONFIG,
      REPO_INVALID: EXIT.FAILURE,
      SUBMODULE_INVALID: EXIT.FAILURE,
      ILLEGAL_TRANSITION: EXIT.FAILURE,
      RUN_BLOCKED: EXIT.BLOCKED,
      AGENT_FAILED: EXIT.FAILURE,
      VERIFIER_FAILED: EXIT.FAILURE,
      GIT_FAILED: EXIT.FAILURE,
      DAEMON_UNAVAILABLE: EXIT.CONFIG,
      NOT_IMPLEMENTED: EXIT.FAILURE,
      INTERNAL: EXIT.FAILURE
    };
    for (const code of BEAVER_ERROR_CODES) {
      expect(exitCodeForError(code)).toBe(expected[code]);
    }
  });
});

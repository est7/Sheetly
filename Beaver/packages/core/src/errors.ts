/**
 * Error contract shared by daemon and clients.
 *
 * The daemon never returns human sentences. It returns a stable `code` plus
 * `params`, and each client localizes the message (see i18n). This keeps the
 * daemon locale-agnostic and satisfies the bilingual requirement.
 */

export const BEAVER_ERROR_CODES = [
  'BAD_REQUEST',
  'NOT_FOUND',
  'CONFIG_INVALID',
  'REPO_INVALID',
  'SUBMODULE_INVALID',
  'ILLEGAL_TRANSITION',
  'RUN_BLOCKED',
  'AGENT_FAILED',
  'VERIFIER_FAILED',
  'GIT_FAILED',
  'DAEMON_UNAVAILABLE',
  'NOT_IMPLEMENTED',
  'INTERNAL'
] as const;

export type BeaverErrorCode = (typeof BEAVER_ERROR_CODES)[number];

/** Interpolation params for the localized message. Values stay primitive. */
export type BeaverErrorParams = Record<string, string | number>;

/** Wire shape returned by the daemon for any non-2xx response. */
export type ApiErrorBody = {
  error: {
    code: BeaverErrorCode;
    params: BeaverErrorParams;
  };
};

export class BeaverError extends Error {
  readonly code: BeaverErrorCode;
  readonly params: BeaverErrorParams;

  constructor(code: BeaverErrorCode, params: BeaverErrorParams = {}) {
    super(`${code} ${JSON.stringify(params)}`);
    this.name = 'BeaverError';
    this.code = code;
    this.params = params;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, params: this.params } };
  }
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (BEAVER_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Stable CLI exit codes (contract):
 *  - 0 success
 *  - 1 execution or validation failure
 *  - 2 blocked / retryable runner state
 *  - 3 configuration or environment problem
 */
export const EXIT = {
  SUCCESS: 0,
  FAILURE: 1,
  BLOCKED: 2,
  CONFIG: 3
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const EXIT_BY_CODE: Record<BeaverErrorCode, ExitCode> = {
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

export function exitCodeForError(code: BeaverErrorCode): ExitCode {
  return EXIT_BY_CODE[code];
}

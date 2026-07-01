import { BeaverError } from './errors';

const SEGMENT_UNSAFE = /[\\/\0]/;

/**
 * Assert a value is safe to use as a SINGLE filesystem path segment (e.g. a
 * runId in `<root>/<runId>`). Rejects empty, `.`, `..`, path separators, and
 * null bytes so an internal id can never escape its intended root
 * (defense-in-depth for the D6 mirror boundary and generated task-pack paths).
 */
export function assertSafePathSegment(value: string, label = 'segment'): void {
  if (value.length === 0 || value === '.' || value === '..' || SEGMENT_UNSAFE.test(value)) {
    throw new BeaverError('BAD_REQUEST', { detail: `unsafe path segment for ${label}: ${JSON.stringify(value)}` });
  }
}

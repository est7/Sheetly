import { BeaverError } from './errors';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const SHELL_META = /[;&|`$<>()[\]{}*?!\n\r]/;

/**
 * Validate a submodule path is safe to pass as an argv value to git.
 *
 * Contract: relative only, no absolute paths, no `..`/`.` segments, no null
 * bytes, no shell metacharacters. Throws `BeaverError('SUBMODULE_INVALID')` so
 * clients can localize the failure. The `path` param carries the offending
 * value for the message.
 */
export function validateSubmodulePath(submodulePath: string): void {
  if (submodulePath.trim().length === 0) {
    throw new BeaverError('SUBMODULE_INVALID', { path: submodulePath, reason: 'empty' });
  }
  if (submodulePath.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(submodulePath)) {
    throw new BeaverError('SUBMODULE_INVALID', { path: submodulePath, reason: 'absolute' });
  }
  if (submodulePath.includes('\0')) {
    throw new BeaverError('SUBMODULE_INVALID', { path: submodulePath, reason: 'null_byte' });
  }
  if (SHELL_META.test(submodulePath)) {
    throw new BeaverError('SUBMODULE_INVALID', { path: submodulePath, reason: 'shell_meta' });
  }
  const segments = submodulePath.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new BeaverError('SUBMODULE_INVALID', { path: submodulePath, reason: 'traversal' });
  }
}

export function validateSubmodulePaths(paths: string[]): void {
  const seen = new Set<string>();
  for (const submodulePath of paths) {
    validateSubmodulePath(submodulePath);
    if (seen.has(submodulePath)) {
      throw new BeaverError('SUBMODULE_INVALID', { path: submodulePath, reason: 'duplicate' });
    }
    seen.add(submodulePath);
  }
}

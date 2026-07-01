import os from 'node:os';
import path from 'node:path';

/**
 * Storage root for all Beaver local facts and artifacts.
 *
 * Contract: `BEAVER_HOME` overrides the default so tests and smoke runs can
 * isolate storage. The default is `~/.beaver`. Callers must treat this as the
 * only source of the storage root — no module should hardcode `~/.beaver`.
 */
export const BEAVER_HOME_ENV = 'BEAVER_HOME';

export function resolveBeaverHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[BEAVER_HOME_ENV];
  if (override && override.trim().length > 0) {
    return path.resolve(expandHome(override.trim()));
  }
  return path.join(os.homedir(), '.beaver');
}

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

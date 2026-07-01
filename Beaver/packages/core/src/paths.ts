import path from 'node:path';
import { resolveBeaverHome } from './env';

/**
 * The on-disk layout under the storage root. This is a shared contract: the
 * daemon owns/writes these paths, and clients (CLI, Electron main) derive the
 * socket/pid paths to reach or manage the daemon. Keeping it in core avoids
 * clients depending on the daemon package.
 */
export type BeaverPaths = {
  home: string;
  socketPath: string;
  pidPath: string;
  configPath: string;
  runsDir: string;
  dbPath: string;
};

export function beaverPaths(env: NodeJS.ProcessEnv = process.env): BeaverPaths {
  const home = resolveBeaverHome(env);
  return {
    home,
    socketPath: path.join(home, 'daemon.sock'),
    pidPath: path.join(home, 'daemon.pid'),
    configPath: path.join(home, 'config.json'),
    runsDir: path.join(home, 'runs'),
    dbPath: path.join(home, 'beaver.sqlite')
  };
}

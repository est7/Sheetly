import { BeaverError, type BeaverConfig, type TaskSource } from '@beaver/core';
import { LocalJsonTaskSource } from './localJsonTaskSource';

/**
 * Build the configured task source. Only the adapters the config schema can
 * actually produce (`localJson`, `larkBase`) are handled; `larkBase` fails
 * explicitly as NOT_IMPLEMENTED until B7 rather than faking upstream success.
 * The `never` default makes adding a new adapter variant a compile error.
 */
export function createTaskSource(config: BeaverConfig, env: NodeJS.ProcessEnv = process.env): TaskSource {
  const source = config.taskSource;
  switch (source.type) {
    case 'localJson':
      return new LocalJsonTaskSource({ path: source.path, defaultRepoPath: config.defaultRepoPath }, env);
    case 'larkBase':
      throw new BeaverError('NOT_IMPLEMENTED', { feature: 'taskSource:larkBase' });
    default: {
      const exhaustive: never = source;
      throw new BeaverError('NOT_IMPLEMENTED', {
        feature: `taskSource:${(exhaustive as { type: string }).type}`
      });
    }
  }
}

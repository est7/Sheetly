import { BeaverError, type BeaverConfig, type TaskSource } from '@beaver/core';
import { LocalJsonTaskSource } from './localJsonTaskSource';
import { LarkBaseTaskSource } from './lark/larkBaseTaskSource';

/**
 * Build the configured task source. Each `TaskSourceType` maps to a sibling
 * adapter that normalizes its upstream into source-neutral ExternalTasks; the
 * `never` default makes adding a new adapter variant a compile error. Adding a
 * source (Linear, …) is a new module + one case here — no downstream change.
 */
export function createTaskSource(config: BeaverConfig, env: NodeJS.ProcessEnv = process.env): TaskSource {
  const source = config.taskSource;
  switch (source.type) {
    case 'localJson':
      return new LocalJsonTaskSource({ path: source.path, defaultRepoPath: config.defaultRepoPath }, env);
    case 'larkBase':
      return new LarkBaseTaskSource(source);
    default: {
      const exhaustive: never = source;
      throw new BeaverError('NOT_IMPLEMENTED', {
        feature: `taskSource:${(exhaustive as { type: string }).type}`
      });
    }
  }
}

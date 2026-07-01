import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BeaverError,
  LocalTaskSchema,
  expandHome,
  resolveBeaverHome,
  type Claim,
  type ExternalTask,
  type TaskSource,
  type TaskUpdate
} from '@beaver/core';

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function describeIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Resolve a configured task-source path against Beaver's storage-root contract:
 * absolute paths are used as-is; a `~/.beaver/...` prefix (the declarative
 * default) redirects to the real `resolveBeaverHome()` so `BEAVER_HOME` isolates
 * it; other `~/` paths expand to the OS home; a relative path is anchored under
 * the Beaver home.
 */
export function resolveConfiguredPath(configured: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(configured)) {
    return configured;
  }
  if (configured === '~/.beaver' || configured.startsWith('~/.beaver/')) {
    return path.join(resolveBeaverHome(env), configured.slice('~/.beaver'.length).replace(/^\//, ''));
  }
  if (configured.startsWith('~/') || configured === '~') {
    return expandHome(configured);
  }
  return path.join(resolveBeaverHome(env), configured);
}

export type LocalJsonTaskSourceOptions = {
  path: string;
  defaultRepoPath: string;
};

/**
 * Local JSON task source: fully functional without credentials. Reads a JSON
 * array of `LocalTask`, maps each to an `ExternalTask` (preserving the full
 * local task losslessly in `raw`), and applies `defaultRepoPath` when a task's
 * `repoPath` is empty. Missing file seeds a schema-valid sample with no
 * machine-specific path. Claim/update are non-mutating interim stubs (D20/B7).
 */
export class LocalJsonTaskSource implements TaskSource {
  private readonly filePath: string;
  private readonly defaultRepoPath: string;

  constructor(options: LocalJsonTaskSourceOptions, env: NodeJS.ProcessEnv = process.env) {
    this.filePath = resolveConfiguredPath(options.path, env);
    this.defaultRepoPath = options.defaultRepoPath;
  }

  async pollAssignedTasks(): Promise<ExternalTask[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isENOENT(error)) {
        throw error;
      }
      await this.seedSample();
      content = await fs.readFile(this.filePath, 'utf8');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new BeaverError('CONFIG_INVALID', { detail: `${this.filePath} is not valid JSON` });
    }
    if (!Array.isArray(parsed)) {
      throw new BeaverError('CONFIG_INVALID', { detail: `${this.filePath} must be a JSON array of tasks` });
    }
    return parsed.map((entry) => this.toExternalTask(entry));
  }

  /** Local claim is derived from runs (D20); nothing is written upstream. */
  async claimTask(_taskId: string, _claim: Claim): Promise<boolean> {
    return true;
  }

  /** A local file has no runner projection to write back; genuine no-op (not faked). */
  async updateTask(_taskId: string, _update: TaskUpdate): Promise<void> {
    return;
  }

  private toExternalTask(entry: unknown): ExternalTask {
    const result = LocalTaskSchema.safeParse(entry);
    if (!result.success) {
      throw new BeaverError('CONFIG_INVALID', { detail: describeIssues(result.error) });
    }
    const local = result.data;
    const repoPath = local.repoPath.trim().length > 0 ? local.repoPath : this.defaultRepoPath;
    return {
      id: local.id,
      sourceType: 'localJson',
      sourceProjectId: this.filePath,
      title: local.title,
      description: local.description,
      acceptanceCriteria: local.acceptanceCriteria,
      assignee: local.assignee,
      raw: { ...local, repoPath }
    };
  }

  private async seedSample(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const sample = [
      {
        id: 'sample-1',
        title: 'Sample Beaver task',
        description: 'Replace with a real assigned task. repoPath is left empty so defaultRepoPath applies.',
        acceptanceCriteria: ['Describe the acceptance criteria here'],
        repoPath: ''
      }
    ];
    await fs.writeFile(this.filePath, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
  }
}

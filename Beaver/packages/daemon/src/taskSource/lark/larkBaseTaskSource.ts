import {
  BeaverError,
  type Claim,
  type ExternalTask,
  type TaskSource,
  type TaskSourceConfig,
  type TaskUpdate
} from '@beaver/core';
import { LarkCli, LarkCliError } from './larkCli';
import { isSurfaced, larkRecordToExternalTask, type LarkMapContext } from './larkMapping';
import { parseLarkBaseUrl } from './larkUrl';

type LarkBaseConfig = Extract<TaskSourceConfig, { type: 'larkBase' }>;

/**
 * Lark Base task source: stateless fetch → map. Each poll asks lark-cli for the
 * records assigned to the logged-in user across the configured Bitables and maps
 * them to source-neutral ExternalTasks. No local status/diff state — the runner
 * state lives in Beaver's runs table (D20), and the daemon caches the tasks in
 * SQLite. Adding another source (Linear, …) is a sibling module + a factory case.
 */
export class LarkBaseTaskSource implements TaskSource {
  private readonly cli: LarkCli;

  constructor(
    private readonly config: LarkBaseConfig,
    cli?: LarkCli
  ) {
    this.cli = cli ?? new LarkCli(config.larkCliBinary);
  }

  async pollAssignedTasks(): Promise<ExternalTask[]> {
    if (this.config.projects.length === 0) {
      throw new BeaverError('CONFIG_INVALID', { detail: 'Lark Base task source has no projects configured' });
    }
    const user = await this.cli.currentUser();
    const tasks: ExternalTask[] = [];

    for (const project of this.config.projects) {
      const { baseToken, tableId } = parseLarkBaseUrl(project.url);
      const fieldTypes = await this.cli.listFields(baseToken, tableId);
      const userFields = [...fieldTypes.entries()].filter(([, type]) => type === 'user').map(([name]) => name);
      if (userFields.length === 0) {
        throw new BeaverError('CONFIG_INVALID', { detail: `Lark project "${project.name}" has no user/person field` });
      }

      const page = await this.cli.listAssignedRecords(baseToken, tableId, user.openId, userFields);
      for (const record of page.records) {
        const baseStage = await this.safeStage(baseToken, tableId, record._record_id);
        if (!isSurfaced(baseStage, this.config.includeDone)) {
          continue;
        }
        const context: LarkMapContext = {
          tableId,
          projectName: project.name,
          baseUrl: project.url,
          openId: user.openId,
          userFields,
          titleField: page.titleField,
          baseStage,
          runner: {
            repoPath: project.repoPath,
            baseBranch: project.baseBranch,
            requiredSubmodules: project.requiredSubmodules,
            agentProfile: project.agentProfile
          }
        };
        tasks.push(larkRecordToExternalTask(record, context));
      }
    }
    return tasks;
  }

  // D20: the local claim is derived from runs, never written back to Lark. From
  // the source's view a claim always succeeds; write-back to the Bitable is a
  // future, explicitly-approved feature (a Base mutation with real blast radius).
  claimTask(_taskId: string, _claim: Claim): Promise<boolean> {
    return Promise.resolve(true);
  }

  updateTask(_taskId: string, _update: TaskUpdate): Promise<void> {
    return Promise.resolve();
  }

  /** A transient history read shouldn't drop the task; only an auth-fatal error
   * (missing scope / no identity) propagates. */
  private async safeStage(baseToken: string, tableId: string, recordId: string): Promise<string | null> {
    try {
      return await this.cli.currentStage(baseToken, tableId, recordId, this.config.historyPages);
    } catch (error) {
      if (error instanceof LarkCliError && error.authFatal) {
        throw error;
      }
      return null;
    }
  }
}

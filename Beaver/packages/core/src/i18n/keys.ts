import type { BeaverErrorCode } from '../errors';
import type { RunStatus } from '../domain';

/**
 * i18n key contract.
 *
 * `MessageCatalog` is typed as `Record<MessageKey, string>`, so a catalog that
 * misses any key fails `tsc`. That compile-time check is the primary
 * "missing translation fails the build" gate required by the design; the
 * runtime parity test is a secondary guard against accidental drift.
 */

export const LOCALES = ['en-US', 'zh-CN'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en-US';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** UI/CLI copy keys. Enum values, event types, and config keys stay English and are NOT here. */
export const UI_MESSAGE_KEYS = [
  'app.title',
  'app.tagline',
  'nav.setup',
  'nav.tasks',
  'nav.runs',
  'nav.logs',
  'setup.storage.title',
  'setup.taskSource.title',
  'setup.submodules.title',
  'setup.verifier.title',
  'setup.agentProfiles.title',
  'setup.automation.title',
  'setup.actions.save',
  'setup.actions.validate',
  'setup.actions.load',
  'setup.actions.sync',
  'tasks.title',
  'tasks.empty',
  'tasks.actions.startRun',
  'tasks.column.id',
  'tasks.column.title',
  'tasks.column.repo',
  'tasks.column.status',
  'run.title',
  'run.actions.start',
  'run.actions.stop',
  'run.actions.retry',
  'run.actions.resume',
  'run.actions.preparePrHandoff',
  'run.actions.openWorktree',
  'run.actions.openRunDir',
  'run.actions.gitStatus',
  'run.logs.stdout',
  'run.logs.stderr',
  'run.logs.verifier',
  'run.files.title',
  'run.timeline.title',
  'common.refresh',
  'common.cancel',
  'common.confirm',
  'common.loading',
  'common.empty',
  'common.error',
  'cli.daemon.started',
  'cli.daemon.alreadyRunning',
  'cli.daemon.stopped',
  'cli.daemon.notRunning',
  'cli.run.started',
  'cli.run.stopped'
] as const;

export type UiMessageKey = (typeof UI_MESSAGE_KEYS)[number];
export type ErrorMessageKey = `error.${BeaverErrorCode}`;
export type StatusMessageKey = `status.${RunStatus}`;

export type MessageKey = UiMessageKey | ErrorMessageKey | StatusMessageKey;

export type MessageCatalog = Record<MessageKey, string>;

export function errorMessageKey(code: BeaverErrorCode): ErrorMessageKey {
  return `error.${code}`;
}

export function statusMessageKey(status: RunStatus): StatusMessageKey {
  return `status.${status}`;
}

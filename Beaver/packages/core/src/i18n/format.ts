import type { ApiErrorBody, BeaverErrorParams } from '../errors';
import type { RunStatus } from '../domain';
import { DEFAULT_LOCALE, errorMessageKey, statusMessageKey, type Locale, type MessageCatalog, type MessageKey } from './keys';
import { enUS } from './messages.en-US';
import { zhCN } from './messages.zh-CN';

const CATALOGS: Record<Locale, MessageCatalog> = {
  'en-US': enUS,
  'zh-CN': zhCN
};

export function getCatalog(locale: Locale): MessageCatalog {
  return CATALOGS[locale];
}

/**
 * Resolve a message and interpolate `{param}` placeholders. The key union is
 * closed and both catalogs are exhaustively typed, so a valid key always
 * resolves; `params` supplies the interpolation values.
 */
export function formatMessage(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {}
): string {
  const template = CATALOGS[locale][key] ?? CATALOGS[DEFAULT_LOCALE][key];
  return interpolate(template, params);
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/** Localize a daemon error body. Clients render this instead of raw strings. */
export function formatApiError(locale: Locale, body: ApiErrorBody): string {
  return formatMessage(locale, errorMessageKey(body.error.code), body.error.params as BeaverErrorParams);
}

export function formatStatus(locale: Locale, status: RunStatus): string {
  return formatMessage(locale, statusMessageKey(status));
}

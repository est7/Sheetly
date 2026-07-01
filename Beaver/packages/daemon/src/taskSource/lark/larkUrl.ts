import { BeaverError } from '@beaver/core';

export type LarkBaseRef = { baseToken: string; tableId: string };

/**
 * Parse a Lark Base share URL into its `base` token and `table` id. Both are
 * required to address a Bitable; a URL missing either is a config error the
 * caller must surface, not silently skip.
 */
export function parseLarkBaseUrl(url: string): LarkBaseRef {
  const baseMatch = url.match(/\/base\/([A-Za-z0-9]+)/);
  const tableMatch = url.match(/[?&]table=(tbl[A-Za-z0-9]+)/);
  if (!baseMatch) {
    throw new BeaverError('CONFIG_INVALID', { detail: `Lark Base URL must contain /base/<token>: ${url}` });
  }
  if (!tableMatch) {
    throw new BeaverError('CONFIG_INVALID', { detail: `Lark Base URL must contain table=<tbl...>: ${url}` });
  }
  return { baseToken: baseMatch[1] as string, tableId: tableMatch[1] as string };
}

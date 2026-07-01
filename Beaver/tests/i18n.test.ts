import { describe, expect, it } from 'vitest';
import {
  BEAVER_ERROR_CODES,
  BeaverError,
  LOCALES,
  RUN_STATUSES,
  formatApiError,
  formatMessage,
  formatStatus,
  getCatalog,
  type Locale
} from '@beaver/core';

describe('i18n catalogs', () => {
  it('define identical key sets across locales', () => {
    const reference = Object.keys(getCatalog('en-US')).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(getCatalog(locale)).sort()).toEqual(reference);
    }
  });

  it('cover every error code and run status in every locale', () => {
    for (const locale of LOCALES) {
      const catalog = getCatalog(locale) as Record<string, string>;
      for (const code of BEAVER_ERROR_CODES) {
        expect(catalog[`error.${code}`]).toBeTruthy();
      }
      for (const status of RUN_STATUSES) {
        expect(catalog[`status.${status}`]).toBeTruthy();
      }
    }
  });

  it('interpolates params', () => {
    expect(formatMessage('en-US', 'cli.daemon.started', { socket: '/x/daemon.sock' })).toBe(
      'Beaver daemon started at /x/daemon.sock'
    );
    expect(formatMessage('zh-CN', 'cli.daemon.started', { socket: '/x/daemon.sock' })).toBe(
      'Beaver daemon 已在 /x/daemon.sock 启动'
    );
  });

  it('localizes a daemon error body per locale', () => {
    const body = new BeaverError('REPO_INVALID', { repoPath: '/x/y' }).toBody();
    expect(formatApiError('en-US', body)).toBe('Not a Git work tree: /x/y');
    expect(formatApiError('zh-CN', body)).toBe('不是 Git 工作树：/x/y');
  });

  it('localizes run status', () => {
    expect(formatStatus('en-US', 'verifying')).toBe('Verifying');
    expect(formatStatus('zh-CN', 'verifying')).toBe('校验中');
  });

  it('leaves unknown placeholders untouched rather than blanking them', () => {
    const locale: Locale = 'en-US';
    expect(formatMessage(locale, 'error.NOT_FOUND', { resource: 'Run' })).toBe('Run not found: {id}');
  });
});

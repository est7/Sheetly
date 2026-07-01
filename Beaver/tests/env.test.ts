import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEAVER_HOME_ENV, expandHome, resolveBeaverHome } from '@beaver/core';

describe('resolveBeaverHome', () => {
  it('defaults to ~/.beaver', () => {
    expect(resolveBeaverHome({})).toBe(path.join(os.homedir(), '.beaver'));
  });

  it('honors BEAVER_HOME override', () => {
    expect(resolveBeaverHome({ [BEAVER_HOME_ENV]: '/tmp/beaver-test' })).toBe('/tmp/beaver-test');
  });

  it('expands a leading ~ in the override', () => {
    expect(resolveBeaverHome({ [BEAVER_HOME_ENV]: '~/beaver-custom' })).toBe(
      path.join(os.homedir(), 'beaver-custom')
    );
  });
});

describe('expandHome', () => {
  it('leaves absolute paths untouched', () => {
    expect(expandHome('/var/data')).toBe('/var/data');
  });
});

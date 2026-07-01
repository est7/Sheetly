import { describe, expect, it } from 'vitest';
import { BeaverError, validateSubmodulePath, validateSubmodulePaths } from '@beaver/core';

describe('validateSubmodulePath', () => {
  it('accepts a safe relative path', () => {
    expect(() => validateSubmodulePath('libs/core')).not.toThrow();
  });

  it.each([
    ['/abs/path', 'absolute'],
    ['../escape', 'traversal'],
    ['a/../b', 'traversal'],
    ['bad;rm -rf', 'shell_meta'],
    ['', 'empty']
  ])('rejects %s', (input, reason) => {
    try {
      validateSubmodulePath(input);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BeaverError);
      expect((error as BeaverError).code).toBe('SUBMODULE_INVALID');
      expect((error as BeaverError).params.reason).toBe(reason);
    }
  });

  it('rejects duplicate paths in a list', () => {
    expect(() => validateSubmodulePaths(['a/b', 'a/b'])).toThrow(BeaverError);
  });
});

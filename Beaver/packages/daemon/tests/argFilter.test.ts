import { describe, expect, test } from 'bun:test';
import { filterBlockedArgs, type BlockedArgMode } from '../src/agent/backend';

const BLOCKED: Record<string, BlockedArgMode> = {
  '-p': 'standalone',
  '--output-format': 'withValue',
  '--mode': 'withValue'
};

describe('filterBlockedArgs', () => {
  test('drops a standalone blocked flag but keeps its neighbours', () => {
    expect(filterBlockedArgs(['-p', '--keep', 'v'], BLOCKED)).toEqual(['--keep', 'v']);
  });

  test('drops a with-value blocked flag AND the following value', () => {
    expect(filterBlockedArgs(['--output-format', 'text', '--keep'], BLOCKED)).toEqual(['--keep']);
  });

  test('drops the inline --flag=value form', () => {
    expect(filterBlockedArgs(['--mode=text', '--keep'], BLOCKED)).toEqual(['--keep']);
  });

  test('passes through unrelated args unchanged', () => {
    expect(filterBlockedArgs(['--model', 'x', '--foo'], BLOCKED)).toEqual(['--model', 'x', '--foo']);
  });
});

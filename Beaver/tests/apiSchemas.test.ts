import { describe, expect, it } from 'vitest';
import {
  REQUEST_SCHEMAS,
  RepoValidateRequestSchema,
  RunActionRequestSchema,
  RunFileReadRequestSchema
} from '@beaver/core';

describe('request schemas', () => {
  it('accepts a valid repo validate body', () => {
    expect(RepoValidateRequestSchema.parse({ repoPath: '/x/y' })).toEqual({ repoPath: '/x/y' });
  });

  it('rejects an empty repoPath', () => {
    expect(RepoValidateRequestSchema.safeParse({ repoPath: '' }).success).toBe(false);
    expect(RepoValidateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('defaults file read location to runDir and rejects unknown locations', () => {
    expect(RunFileReadRequestSchema.parse({ fileName: 'task.md' }).location).toBe('runDir');
    expect(RunFileReadRequestSchema.safeParse({ fileName: 'x', location: 'nope' }).success).toBe(false);
  });

  it('rejects traversal/absolute fileName but allows nested relative paths', () => {
    expect(RunFileReadRequestSchema.safeParse({ fileName: '../config.json' }).success).toBe(false);
    expect(RunFileReadRequestSchema.safeParse({ fileName: '/etc/passwd' }).success).toBe(false);
    expect(RunFileReadRequestSchema.safeParse({ fileName: 'a/../b' }).success).toBe(false);
    expect(RunFileReadRequestSchema.safeParse({ fileName: 'sub/dir/task.md' }).success).toBe(true);
  });

  it('rejects unknown tool actions', () => {
    expect(RunActionRequestSchema.safeParse({ action: 'prepare_handoff' }).success).toBe(true);
    expect(RunActionRequestSchema.safeParse({ action: 'rm_rf' }).success).toBe(false);
  });

  it('exposes a schema per request-bearing route', () => {
    expect(Object.keys(REQUEST_SCHEMAS).sort()).toEqual(
      ['configSet', 'repoValidate', 'runActions', 'runFileRead', 'runsStart', 'tasksClaim'].sort()
    );
  });
});

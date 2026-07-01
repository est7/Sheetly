import { describe, expect, it } from 'vitest';
import { BeaverConfigSchema } from '@beaver/core';

describe('BeaverConfigSchema', () => {
  it('fills defaults for an empty object and targets ~/.beaver', () => {
    const config = BeaverConfigSchema.parse({});
    expect(config.workspaceRoot).toBe('~/.beaver/workspaces');
    expect(config.gitBinary).toBe('git');
    expect(config.taskSource.type).toBe('localJson');
    expect(config.automation).toBeUndefined();
  });

  it('rejects a defaultAgentProfile missing from agentProfiles when profiles exist', () => {
    const result = BeaverConfigSchema.safeParse({
      defaultAgentProfile: 'ghost',
      agentProfiles: { generic: { command: 'codex' } }
    });
    expect(result.success).toBe(false);
  });

  it('accepts a larkBase task source with defaults', () => {
    const config = BeaverConfigSchema.parse({ taskSource: { type: 'larkBase' } });
    expect(config.taskSource.type).toBe('larkBase');
    if (config.taskSource.type === 'larkBase') {
      expect(config.taskSource.statePath).toBe('~/.beaver/lark-base/projects.json');
      expect(config.taskSource.larkCliBinary).toBe('lark-cli');
    }
  });
});

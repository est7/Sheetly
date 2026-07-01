import { describe, expect, test } from 'bun:test';
import type { TaskSourceConfig } from '@beaver/core';
import { LarkBaseTaskSource } from '../src/taskSource/lark/larkBaseTaskSource';
import { LarkCli, type SpawnResult } from '../src/taskSource/lark/larkCli';
import {
  docLink,
  isSurfaced,
  larkRecordToExternalTask,
  parseDocLink,
  rolesOf,
  type LarkMapContext
} from '../src/taskSource/lark/larkMapping';

type LarkBaseConfig = Extract<TaskSourceConfig, { type: 'larkBase' }>;

const OU = 'ou_me';

function larkConfig(over: Partial<LarkBaseConfig> = {}): LarkBaseConfig {
  return {
    type: 'larkBase',
    projects: [{ name: 'Web', url: 'https://x.feishu.cn/base/BASE1?table=tbl1', repoPath: '/repos/web', baseBranch: 'develop' }],
    larkCliBinary: 'lark-cli',
    statePath: '~/.beaver/lark-base/projects.json',
    syncIntervalMinutes: 0,
    includeDone: false,
    historyPages: 4,
    ...over
  };
}

/** Fake spawnCli dispatching by lark-cli subcommand. */
function fakeCli(handlers: Record<string, unknown>): (binary: string, args: string[]) => Promise<SpawnResult> {
  return (_binary, args) => {
    const key = args[0] === 'auth' ? 'auth' : (args[1] ?? '');
    const payload = handlers[key] ?? { ok: true, data: {} };
    return Promise.resolve({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
  };
}

const AUTH_OK = {
  identities: { user: { available: true, openId: OU, userName: 'Est', scope: 'base:app:read base:field:read base:record:read base:history:read' } }
};

describe('larkMapping (pure)', () => {
  test('rolesOf lists user-fields that contain me', () => {
    const record = { _record_id: 'r', Owner: [{ id: OU }], Reviewer: [{ id: 'ou_other' }] };
    expect(rolesOf(record, OU, ['Owner', 'Reviewer'])).toEqual(['Owner']);
  });

  test('docLink + parseDocLink resolve a markdown or bare link', () => {
    expect(docLink({ _record_id: 'r', PRD: '[Spec](https://doc/1)' })).toBe('[Spec](https://doc/1)');
    expect(parseDocLink('[Spec](https://doc/1)')).toEqual({ label: 'Spec', url: 'https://doc/1' });
    expect(parseDocLink('https://doc/2')).toEqual({ url: 'https://doc/2' });
  });

  test('isSurfaced honours includeDone against terminal stages', () => {
    expect(isSurfaced('上线', false)).toBe(false);
    expect(isSurfaced('上线', true)).toBe(true);
    expect(isSurfaced('开发实现中', false)).toBe(true);
    expect(isSurfaced(null, false)).toBe(true);
  });

  test('larkRecordToExternalTask namespaces id and threads runner overrides into raw', () => {
    const context: LarkMapContext = {
      tableId: 'tbl1',
      projectName: 'Web',
      baseUrl: 'https://x/base/B?table=tbl1',
      openId: OU,
      userFields: ['Owner'],
      titleField: 'Title',
      baseStage: '开发实现中',
      runner: { repoPath: '/repos/web', baseBranch: 'develop', agentProfile: 'claude' }
    };
    const task = larkRecordToExternalTask({ _record_id: 'rec9', Title: 'Ship it', Owner: [{ id: OU }], PRD: 'https://doc/9' }, context);
    expect(task.id).toBe('lark:tbl1:rec9');
    expect(task.sourceType).toBe('larkBase');
    expect(task.title).toBe('Ship it');
    expect(task.assignee).toBe('Owner');
    expect(task.businessStatus).toBe('开发实现中');
    expect(task.productDocUrl).toBe('https://doc/9');
    expect(task.raw).toMatchObject({ repoPath: '/repos/web', baseBranch: 'develop', agentProfile: 'claude', recordId: 'rec9' });
    expect(task.raw.requiredSubmodules).toBeUndefined();
  });
});

describe('LarkBaseTaskSource.pollAssignedTasks', () => {
  test('fetches assigned records and maps them, applying project runner overrides', async () => {
    const cli = new LarkCli(
      'lark-cli',
      fakeCli({
        auth: AUTH_OK,
        '+field-list': { ok: true, data: { fields: [{ name: 'Title', type: 'text' }, { name: 'Owner', type: 'user' }] } },
        '+record-list': {
          ok: true,
          data: { fields: ['Title', 'Owner'], data: [['Fix login', [{ id: OU }]]], record_id_list: ['rec1'], has_more: false }
        },
        '+record-history-list': { ok: true, data: { items: [{ rev: 3, field_changes: [{ field_type: 'Stage', after: '开发实现中' }] }], has_more: false } }
      })
    );
    const tasks = await new LarkBaseTaskSource(larkConfig(), cli).pollAssignedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'lark:tbl1:rec1',
      title: 'Fix login',
      businessStatus: '开发实现中',
      assignee: 'Owner'
    });
    expect(tasks[0]?.raw).toMatchObject({ repoPath: '/repos/web', baseBranch: 'develop' });
  });

  test('drops terminal-stage records when includeDone is false', async () => {
    const cli = new LarkCli(
      'lark-cli',
      fakeCli({
        auth: AUTH_OK,
        '+field-list': { ok: true, data: { fields: [{ name: 'Title', type: 'text' }, { name: 'Owner', type: 'user' }] } },
        '+record-list': { ok: true, data: { fields: ['Title', 'Owner'], data: [['Old', [{ id: OU }]]], record_id_list: ['recX'], has_more: false } },
        '+record-history-list': { ok: true, data: { items: [{ rev: 1, field_changes: [{ field_type: 'Stage', after: '上线' }] }], has_more: false } }
      })
    );
    expect(await new LarkBaseTaskSource(larkConfig(), cli).pollAssignedTasks()).toHaveLength(0);
  });

  test('rejects a project with no user/person field', async () => {
    const cli = new LarkCli(
      'lark-cli',
      fakeCli({ auth: AUTH_OK, '+field-list': { ok: true, data: { fields: [{ name: 'Title', type: 'text' }] } } })
    );
    await expect(new LarkBaseTaskSource(larkConfig(), cli).pollAssignedTasks()).rejects.toThrow(/user\/person field/);
  });

  test('rejects an empty project list', async () => {
    const cli = new LarkCli('lark-cli', fakeCli({ auth: AUTH_OK }));
    await expect(new LarkBaseTaskSource(larkConfig({ projects: [] }), cli).pollAssignedTasks()).rejects.toThrow(/no projects/);
  });

  test('claim/update are non-mutating stubs (D20)', async () => {
    const source = new LarkBaseTaskSource(larkConfig(), new LarkCli('lark-cli', fakeCli({ auth: AUTH_OK })));
    expect(await source.claimTask('lark:tbl1:rec1', { runId: 'r', deviceId: 'd', claimedAt: 'now' })).toBe(true);
    await expect(source.updateTask('lark:tbl1:rec1', { runnerUpdatedAt: 'now' })).resolves.toBeUndefined();
  });
});

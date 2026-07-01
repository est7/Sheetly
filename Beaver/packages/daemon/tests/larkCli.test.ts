import { describe, expect, test } from 'bun:test';
import { LarkCli, LarkCliError, type SpawnResult } from '../src/taskSource/lark/larkCli';
import { parseLarkBaseUrl } from '../src/taskSource/lark/larkUrl';

/** Build a fake spawnCli that dispatches on the lark-cli subcommand and returns
 * a canned envelope. `queue` lets a single command return successive pages. */
function fakeCli(handlers: Record<string, unknown[]>): {
  spawn: (binary: string, args: string[]) => Promise<SpawnResult>;
  calls: string[][];
} {
  const cursors: Record<string, number> = {};
  const calls: string[][] = [];
  const key = (args: string[]): string => {
    if (args[0] === 'auth') return 'auth';
    return args[1] ?? args[0] ?? '';
  };
  const spawn = (_binary: string, args: string[]): Promise<SpawnResult> => {
    calls.push(args);
    const k = key(args);
    const pages = handlers[k] ?? [];
    const idx = cursors[k] ?? 0;
    cursors[k] = idx + 1;
    const payload = pages[Math.min(idx, pages.length - 1)] ?? { ok: true, data: {} };
    return Promise.resolve({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
  };
  return { spawn, calls };
}

describe('parseLarkBaseUrl', () => {
  test('extracts base token and table id', () => {
    expect(parseLarkBaseUrl('https://x.feishu.cn/base/BASETOKEN123?table=tblABC456&view=v')).toEqual({
      baseToken: 'BASETOKEN123',
      tableId: 'tblABC456'
    });
  });
  test('rejects a URL missing base or table', () => {
    expect(() => parseLarkBaseUrl('https://x.feishu.cn/base/BASETOKEN123')).toThrow(/table=/);
    expect(() => parseLarkBaseUrl('https://x.feishu.cn/docs/foo?table=tblABC')).toThrow(/\/base\//);
  });
});

describe('LarkCli.currentUser', () => {
  test('returns the user when identity + scopes are present', async () => {
    const { spawn } = fakeCli({
      auth: [
        {
          identities: {
            user: { available: true, openId: 'ou_123', userName: 'Est', scope: 'base:app:read base:field:read base:record:read base:history:read' }
          }
        }
      ]
    });
    const user = await new LarkCli('lark-cli', spawn).currentUser();
    expect(user).toEqual({ openId: 'ou_123', userName: 'Est' });
  });

  test('throws no_user_identity when not logged in', async () => {
    const { spawn } = fakeCli({ auth: [{ identities: { user: { available: false } } }] });
    try {
      await new LarkCli('lark-cli', spawn).currentUser();
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LarkCliError);
      expect((error as LarkCliError).subtype).toBe('no_user_identity');
      expect((error as LarkCliError).authFatal).toBe(true);
    }
  });

  test('throws missing_scope when a read scope is absent', async () => {
    const { spawn } = fakeCli({
      auth: [{ identities: { user: { available: true, openId: 'ou_1', scope: 'base:app:read' } } }]
    });
    await expect(new LarkCli('lark-cli', spawn).currentUser()).rejects.toMatchObject({ subtype: 'missing_scope' });
  });
});

describe('LarkCli.listFields', () => {
  test('pages until a short page and maps name->type', async () => {
    const page1 = { ok: true, data: { fields: Array.from({ length: 200 }, (_, i) => ({ name: `f${i}`, type: 'text' })) } };
    const page2 = { ok: true, data: { fields: [{ name: 'owner', type: 'user' }] } };
    const { spawn, calls } = fakeCli({ '+field-list': [page1, page2] });
    const types = await new LarkCli('lark-cli', spawn).listFields('B', 'tbl1');
    expect(types.get('owner')).toBe('user');
    expect(types.size).toBe(201);
    expect(calls.filter((c) => c[1] === '+field-list')).toHaveLength(2); // paged twice
  });
});

describe('LarkCli.listAssignedRecords', () => {
  test('builds an OR-contains filter and zips fields with rows', async () => {
    const page = {
      ok: true,
      data: {
        fields: ['Title', 'Owner'],
        data: [['Fix bug', [{ id: 'ou_1' }]]],
        record_id_list: ['rec_1'],
        has_more: false
      }
    };
    const { spawn, calls } = fakeCli({ '+record-list': [page] });
    const result = await new LarkCli('lark-cli', spawn).listAssignedRecords('B', 'tbl1', 'ou_1', ['Owner']);
    expect(result.titleField).toBe('Title');
    expect(result.records[0]).toMatchObject({ _record_id: 'rec_1', Title: 'Fix bug' });
    const filterArg = calls[0]?.[calls[0].indexOf('--filter-json') + 1] ?? '';
    expect(JSON.parse(filterArg)).toEqual({ logic: 'or', conditions: [['Owner', 'contains', 'ou_1']] });
  });

  test('rejects a rows/record-id length mismatch (no fake undefined id)', async () => {
    const page = { ok: true, data: { fields: ['Title'], data: [['a'], ['b']], record_id_list: ['rec1'], has_more: false } };
    const { spawn } = fakeCli({ '+record-list': [page] });
    await expect(new LarkCli('lark-cli', spawn).listAssignedRecords('B', 'tbl1', 'ou_1', ['Owner'])).rejects.toThrow(
      /2 rows but 1 record ids/
    );
  });
});

describe('LarkCli.currentStage', () => {
  test('returns the Stage field_change after-value', async () => {
    const hist = {
      ok: true,
      data: { items: [{ rev: 5, field_changes: [{ field_type: 'Stage', after: '开发实现中' }] }], has_more: false }
    };
    const { spawn } = fakeCli({ '+record-history-list': [hist] });
    const stage = await new LarkCli('lark-cli', spawn).currentStage('B', 'tbl1', 'rec_1', 4);
    expect(stage).toBe('开发实现中');
  });

  test('returns null when no Stage change is found', async () => {
    const hist = { ok: true, data: { items: [{ rev: 1, field_changes: [] }], has_more: false } };
    const { spawn } = fakeCli({ '+record-history-list': [hist] });
    expect(await new LarkCli('lark-cli', spawn).currentStage('B', 'tbl1', 'rec_1', 4)).toBeNull();
  });
});

describe('LarkCli envelope errors', () => {
  test('ok:false surfaces as a LarkCliError with subtype', async () => {
    const { spawn } = fakeCli({ '+field-list': [{ ok: false, error: { subtype: 'permission_denied', message: 'nope' } }] });
    await expect(new LarkCli('lark-cli', spawn).listFields('B', 'tbl1')).rejects.toMatchObject({
      subtype: 'permission_denied',
      message: 'nope'
    });
  });
});

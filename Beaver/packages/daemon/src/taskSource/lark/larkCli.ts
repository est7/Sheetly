import { spawn } from 'node:child_process';
import { z } from 'zod';

/**
 * Lark-only protocol client: every lark-cli invocation, JSON envelope handling,
 * and error classification lives here, sealed from the rest of the task-source
 * layer. Nothing outside this file knows lark-cli exists. The public surface is
 * the four read operations the Bitable task source needs plus auth.
 */

const REQUIRED_SCOPES = ['base:app:read', 'base:field:read', 'base:record:read', 'base:history:read'] as const;

/** lark-cli error with an upstream subtype, so callers can distinguish an
 * auth/scope problem (fatal, needs `lark-cli auth login`) from a transient one. */
export class LarkCliError extends Error {
  readonly subtype: string;

  constructor(message: string, subtype = '') {
    super(message);
    this.name = 'LarkCliError';
    this.subtype = subtype;
  }

  get authFatal(): boolean {
    return this.subtype === 'missing_scope' || this.subtype === 'no_user_identity';
  }
}

export type LarkUser = { openId: string; userName: string };
export type LarkField = { name: string; type: string };
export type LarkRecord = Record<string, unknown> & { _record_id: string };
export type LarkRecordPage = { records: LarkRecord[]; titleField: string };

const FIELD_PAGE = 200;
const RECORD_PAGE = 200;

export class LarkCli {
  constructor(
    private readonly binary: string,
    private readonly spawnCli: SpawnCli = defaultSpawnCli
  ) {}

  /** Resolve the logged-in user + assert the token carries the read scopes. */
  async currentUser(): Promise<LarkUser> {
    const payload = await this.runRaw(['auth', 'status']);
    const user = (payload.identities as { user?: Record<string, unknown> } | undefined)?.user;
    const openId = typeof user?.openId === 'string' ? user.openId : '';
    if (!user?.available || !openId) {
      throw new LarkCliError('No logged-in Lark user. Run `lark-cli auth login` first.', 'no_user_identity');
    }
    const scopes = new Set(String(user.scope ?? '').split(/\s+/).filter(Boolean));
    const missing = REQUIRED_SCOPES.filter((scope) => !scopes.has(scope));
    if (missing.length > 0) {
      throw new LarkCliError(`Lark user token missing scopes: ${missing.join(' ')}`, 'missing_scope');
    }
    return { openId, userName: typeof user.userName === 'string' ? user.userName : '' };
  }

  /** Full field-name → field-type map for a table (paged). */
  async listFields(baseToken: string, tableId: string): Promise<Map<string, string>> {
    const types = new Map<string, string>();
    for (let offset = 0; ; offset += FIELD_PAGE) {
      const data = await this.runJson([
        'base', '+field-list',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--limit', String(FIELD_PAGE),
        '--offset', String(offset)
      ]);
      const fields = z.array(z.object({ name: z.string(), type: z.string() })).parse(data.fields);
      for (const field of fields) {
        types.set(field.name, field.type);
      }
      if (fields.length < FIELD_PAGE) {
        return types;
      }
    }
  }

  /** Records where any of `userFields` contains `openId` (assigned to me), paged. */
  async listAssignedRecords(
    baseToken: string,
    tableId: string,
    openId: string,
    userFields: string[]
  ): Promise<LarkRecordPage> {
    const filterJson = JSON.stringify({
      logic: 'or',
      conditions: userFields.map((name) => [name, 'contains', openId])
    });
    const records: LarkRecord[] = [];
    let titleField = '';
    for (let offset = 0; ; offset += RECORD_PAGE) {
      const data = await this.runJson([
        'base', '+record-list',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--filter-json', filterJson,
        '--limit', String(RECORD_PAGE),
        '--offset', String(offset)
      ]);
      const fields = z.array(z.string()).parse(data.fields);
      const rows = z.array(z.array(z.unknown())).parse(data.data ?? []);
      const recordIds = z.array(z.string()).parse(data.record_id_list);
      if (fields.length > 0 && !titleField) {
        titleField = fields[0] as string;
      }
      for (let i = 0; i < rows.length; i += 1) {
        const record: LarkRecord = { _record_id: recordIds[i] as string };
        const row = rows[i] as unknown[];
        for (let f = 0; f < fields.length; f += 1) {
          record[fields[f] as string] = row[f];
        }
        records.push(record);
      }
      if (!data.has_more || rows.length === 0) {
        return { records, titleField };
      }
    }
  }

  /** The current `Stage` value from a record's change history, or null. Walks
   * back up to `historyPages` pages of revisions. */
  async currentStage(baseToken: string, tableId: string, recordId: string, historyPages: number): Promise<string | null> {
    let maxVersion: number | null = null;
    for (let page = 0; page < historyPages; page += 1) {
      const args = [
        'base', '+record-history-list',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--record-id', recordId,
        '--page-size', '50'
      ];
      if (maxVersion !== null) {
        args.push('--max-version', String(maxVersion));
      }
      const data = await this.runJson(args);
      const items = z.array(z.record(z.unknown())).parse(data.items ?? []);
      for (const item of items) {
        const changes = z.array(z.record(z.unknown())).catch([]).parse(item.field_changes);
        for (const change of changes) {
          if (change.field_type === 'Stage') {
            return typeof change.after === 'string' && change.after.length > 0 ? change.after : null;
          }
        }
      }
      const revisions = items.map((item) => item.rev).filter((rev): rev is number => typeof rev === 'number');
      if (!data.has_more || revisions.length === 0) {
        return null;
      }
      maxVersion = Math.min(...revisions) - 1;
    }
    return null;
  }

  /** Run a data command: appends `--as user --format json`, unwraps the
   * `{ ok, data, error }` envelope, throws LarkCliError on `ok:false`. */
  private async runJson(args: string[]): Promise<Record<string, any>> {
    const payload = await this.runRaw([...args, '--as', 'user', '--format', 'json']);
    if (!payload.ok) {
      const error = z.object({ subtype: z.string().optional(), message: z.string().optional() }).catch({}).parse(payload.error);
      throw new LarkCliError(error.message ?? 'lark-cli error', error.subtype ?? '');
    }
    return z.record(z.unknown()).parse(payload.data ?? {}) as Record<string, any>;
  }

  private async runRaw(args: string[]): Promise<Record<string, any>> {
    const { code, stdout, stderr } = await this.spawnCli(this.binary, args);
    if (code !== 0) {
      throw new LarkCliError(`${this.binary} exited with code ${code}: ${(stderr || stdout).trim()}`);
    }
    try {
      return JSON.parse(stdout) as Record<string, any>;
    } catch {
      throw new LarkCliError(`Non-JSON output from ${this.binary}: ${stdout.slice(0, 200)}`);
    }
  }
}

export type SpawnResult = { code: number | null; stdout: string; stderr: string };
export type SpawnCli = (binary: string, args: string[]) => Promise<SpawnResult>;

/** argv-only spawn (never a shell). Injectable so tests drive a fake CLI. */
function defaultSpawnCli(binary: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => reject(new LarkCliError(`Failed to run ${binary}: ${error.message}`)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

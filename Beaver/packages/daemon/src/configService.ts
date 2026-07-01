import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BeaverConfigSchema, BeaverError, type BeaverConfig } from '@beaver/core';

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function describeIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Config lives at `<home>/config.json` as validated JSON. A missing file yields
 * schema defaults; invalid JSON or a schema violation fails as CONFIG_INVALID
 * (exit 3) rather than being silently repaired.
 */
export class ConfigService {
  constructor(private readonly configPath: string) {}

  async get(): Promise<BeaverConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, 'utf8');
    } catch (error) {
      if (isENOENT(error)) {
        return BeaverConfigSchema.parse({});
      }
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new BeaverError('CONFIG_INVALID', { detail: 'config.json is not valid JSON' });
    }
    const parsed = BeaverConfigSchema.safeParse(json);
    if (!parsed.success) {
      throw new BeaverError('CONFIG_INVALID', { detail: describeIssues(parsed.error) });
    }
    return parsed.data;
  }

  async save(input: unknown): Promise<BeaverConfig> {
    const parsed = BeaverConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new BeaverError('CONFIG_INVALID', { detail: describeIssues(parsed.error) });
    }
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    return parsed.data;
  }
}

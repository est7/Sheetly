import type { ExternalTask } from '@beaver/core';
import type { LarkRecord } from './larkCli';

/**
 * Pure Lark-record → ExternalTask mapping. All Lark-specific interpretation
 * (which fields are the assignee, where the doc link is, how a Base Stage reads)
 * lives here; the output is a source-neutral ExternalTask whose Lark details are
 * preserved losslessly in `raw`. Downstream never sees a Lark concept.
 */

const DOC_FIELD_HINTS = ['文档', '链接', 'doc', 'url', 'prd'];

/** Base stages that mean the work has shipped — used to honour `includeDone`. */
export const TERMINAL_STAGES = new Set(['上线', 'done', 'Done', '已上线']);

export type LarkMapContext = {
  tableId: string;
  projectName: string;
  baseUrl: string;
  openId: string;
  userFields: string[];
  titleField: string;
  /** Current Base Stage resolved from record history, if any. */
  baseStage: string | null;
  /** Per-project runner overrides; surfaced in `raw` so the orchestrator's
   * buildRun picks them up (repoPath / baseBranch / submodules / agent). */
  runner: {
    repoPath?: string;
    baseBranch?: string;
    requiredSubmodules?: string[];
    agentProfile?: string;
  };
};

/** Which of the configured user-fields list this user — the record's "roles". */
export function rolesOf(record: LarkRecord, openId: string, userFields: string[]): string[] {
  const roles: string[] = [];
  for (const field of userFields) {
    const people = record[field];
    if (
      Array.isArray(people) &&
      people.some((p) => typeof p === 'object' && p !== null && 'id' in p && (p as { id: unknown }).id === openId)
    ) {
      roles.push(field);
    }
  }
  return roles;
}

/** First string field whose name hints at a doc/link/PRD. */
export function docLink(record: LarkRecord): string | null {
  for (const [name, value] of Object.entries(record)) {
    if (name === '_record_id' || typeof value !== 'string' || value.length === 0) {
      continue;
    }
    if (DOC_FIELD_HINTS.some((hint) => name.toLowerCase().includes(hint.toLowerCase()))) {
      return value;
    }
  }
  return null;
}

export type ParsedDoc = { label?: string; url?: string };

/** A `[label](url)` markdown link, a bare URL, or plain label text. */
export function parseDocLink(doc: string | null): ParsedDoc {
  if (!doc) {
    return {};
  }
  const markdown = doc.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (markdown) {
    return { label: markdown[1], url: markdown[2] };
  }
  try {
    return { url: new URL(doc).toString() };
  } catch {
    return { label: doc };
  }
}

function title(record: LarkRecord, titleField: string): string {
  const value = record[titleField];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return value == null ? 'Untitled Lark Base record' : String(value);
}

function renderDescription(context: LarkMapContext, roles: string[], doc: ParsedDoc): string {
  const lines = [
    `Lark Base record from project ${context.projectName}.`,
    '',
    `Base Stage: ${context.baseStage ?? 'unknown'}`,
    `Roles: ${roles.length > 0 ? roles.join(', ') : 'unknown'}`
  ];
  if (doc.url) {
    lines.push(`Product document: ${doc.label ? `${doc.label} (${doc.url})` : doc.url}`);
  }
  if (context.baseUrl) {
    lines.push(`Base URL: ${context.baseUrl}`);
  }
  return lines.join('\n');
}

function renderAcceptanceCriteria(docUrl: string | undefined): string[] {
  const criteria = [
    'Implement the request represented by this Lark Base record.',
    'Do not push branches or delete user files automatically.'
  ];
  if (docUrl) {
    criteria.unshift('Read the linked product document before making code changes.');
  }
  return criteria;
}

export function larkRecordToExternalTask(record: LarkRecord, context: LarkMapContext): ExternalTask {
  const roles = rolesOf(record, context.openId, context.userFields);
  const doc = parseDocLink(docLink(record));
  return {
    id: `lark:${context.tableId}:${record._record_id}`,
    sourceType: 'larkBase',
    sourceProjectId: context.tableId,
    title: title(record, context.titleField),
    description: renderDescription(context, roles, doc),
    acceptanceCriteria: renderAcceptanceCriteria(doc.url),
    productDocUrl: doc.url,
    assignee: roles.length > 0 ? roles.join(', ') : undefined,
    businessStatus: context.baseStage ?? undefined,
    raw: {
      projectName: context.projectName,
      tableId: context.tableId,
      recordId: record._record_id,
      baseUrl: context.baseUrl,
      baseStage: context.baseStage,
      roles,
      docLabel: doc.label,
      docUrl: doc.url,
      // Runner overrides the orchestrator's buildRun reads off task.raw. Only
      // defined ones are set so buildRun's `|| config default` fallbacks apply.
      ...(context.runner.repoPath ? { repoPath: context.runner.repoPath } : {}),
      ...(context.runner.baseBranch ? { baseBranch: context.runner.baseBranch } : {}),
      ...(context.runner.requiredSubmodules ? { requiredSubmodules: context.runner.requiredSubmodules } : {}),
      ...(context.runner.agentProfile ? { agentProfile: context.runner.agentProfile } : {}),
      record
    }
  };
}

/** Whether a record should be surfaced given the `includeDone` setting. */
export function isSurfaced(baseStage: string | null, includeDone: boolean): boolean {
  if (includeDone) {
    return true;
  }
  return baseStage === null || !TERMINAL_STAGES.has(baseStage);
}

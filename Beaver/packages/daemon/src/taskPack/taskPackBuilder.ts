import { promises as fs } from 'node:fs';
import path from 'node:path';

export type TaskPackInput = {
  runId: string;
  worktreePath: string;
  /** `<home>/runs` — the inspectable mirror root. */
  runsDir: string;
  task: { id: string; title: string; description: string; acceptanceCriteria: string[] };
  constraints: { repoPath: string; baseBranch: string; requiredSubmodules: string[] };
  /** Optional command lines (e.g. the verifier) surfaced to the agent. */
  commands?: string[];
};

export type MaterializedArtifact = { kind: string; path: string };

export type TaskPackResult = {
  /** Prompt pack inside the worktree the agent reads. */
  packDir: string;
  /** Home run-dir mirror (events.jsonl / logs / summary / diff land here). */
  runDir: string;
  artifacts: MaterializedArtifact[];
};

/**
 * Materializes the run's task pack. Pure filesystem: it writes the worktree
 * prompt pack (`<worktree>/.runs/<runId>/…`) the agent reads, and creates the
 * home run-dir mirror (`<home>/runs/<runId>/`). It returns artifact descriptors;
 * registering them in SQLite is the caller's job (keeps this builder DB-free).
 */
export class TaskPackBuilder {
  async materialize(input: TaskPackInput): Promise<TaskPackResult> {
    const packDir = path.join(input.worktreePath, '.runs', input.runId);
    const runDir = path.join(input.runsDir, input.runId);
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(runDir, { recursive: true });

    const files: Record<string, string> = {
      'task.md': renderTask(input.task),
      'acceptance.md': renderAcceptance(input.task.acceptanceCriteria),
      'constraints.md': renderConstraints(input.runId, input.constraints),
      'commands.md': renderCommands(input.commands),
      'findings.json': `${JSON.stringify({ findings: [] }, null, 2)}\n`,
      'transcript.jsonl': ''
    };

    const artifacts: MaterializedArtifact[] = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(packDir, name);
      await fs.writeFile(filePath, content, 'utf8');
      artifacts.push({ kind: `taskpack:${name}`, path: filePath });
    }
    return { packDir, runDir, artifacts };
  }
}

function renderTask(task: TaskPackInput['task']): string {
  return `# Task ${task.id}\n\n## ${task.title}\n\n${task.description || '(no description)'}\n`;
}

function renderAcceptance(criteria: string[]): string {
  const body = criteria.length > 0 ? criteria.map((c) => `- [ ] ${c}`).join('\n') : '- [ ] (no acceptance criteria provided)';
  return `# Acceptance Criteria\n\n${body}\n`;
}

function renderConstraints(runId: string, constraints: TaskPackInput['constraints']): string {
  const submodules =
    constraints.requiredSubmodules.length > 0
      ? constraints.requiredSubmodules.map((s) => `  - ${s}`).join('\n')
      : '  - (none)';
  return `# Constraints

- Repo path: ${constraints.repoPath}
- Base branch: ${constraints.baseBranch}
- Required submodules:
${submodules}

## Safety (do not violate)

- Do NOT run destructive Git operations without explicit user action.
- Do NOT push automatically or open a remote PR.
- Do NOT delete user files or the worktree.
- Write findings to \`.runs/${runId}/findings.json\`.
`;
}

function renderCommands(commands?: string[]): string {
  const body = commands && commands.length > 0 ? commands.map((c) => `- \`${c}\``).join('\n') : '- (none configured)';
  return `# Commands\n\n${body}\n`;
}

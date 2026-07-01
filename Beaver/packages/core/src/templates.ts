/**
 * Command template interpolation for agent/verifier profiles.
 *
 * Only a fixed set of variables is allowed; an unknown `{{var}}` throws rather
 * than silently expanding to empty, so a typo in config surfaces immediately.
 * Interpolation happens per-argv-entry, never as a shell string.
 */
export type TemplateVariables = {
  taskId: string;
  runId: string;
  runDir: string;
  repoPath: string;
  worktreePath: string;
  branchName: string;
};

const TEMPLATE_VARIABLES: Array<keyof TemplateVariables> = [
  'taskId',
  'runId',
  'runDir',
  'repoPath',
  'worktreePath',
  'branchName'
];

export function interpolateTemplate(input: string, variables: TemplateVariables): string {
  // Match ANY `{{...}}` (not just well-formed identifiers) so malformed names
  // like `{{worktree-path}}` are rejected instead of silently left literal.
  return input.replace(/\{\{([^{}]*)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (!TEMPLATE_VARIABLES.includes(key as keyof TemplateVariables)) {
      throw new Error(`Unknown command template variable: ${key}`);
    }
    return variables[key as keyof TemplateVariables];
  });
}

export function interpolateArgs(args: string[], variables: TemplateVariables): string[] {
  return args.map((arg) => interpolateTemplate(arg, variables));
}

import { z } from 'zod';
import { BeaverConfigSchema } from './config';

/**
 * Runtime request-body validation for the daemon boundary (D8b: strict in,
 * precise out). Schemas are the single source; request types are `z.infer`red
 * from them, so the wire shape and the TypeScript type cannot drift.
 *
 * Value enums that appear in request bodies (ToolAction, RunFileLocation) live
 * here too so both the schema and the type come from one place.
 */

export const ToolActionSchema = z.enum([
  'pipeline_status',
  'ship_fast_gate',
  'ship_push_snapshot',
  'prepare_handoff'
]);
export type ToolAction = z.infer<typeof ToolActionSchema>;

export const RunFileLocationSchema = z.enum(['runDir', 'worktree']);
export type RunFileLocation = z.infer<typeof RunFileLocationSchema>;

export const RepoValidateRequestSchema = z.object({ repoPath: z.string().min(1) });
export type RepoValidateRequest = z.infer<typeof RepoValidateRequestSchema>;

export const TaskClaimRequestSchema = z.object({ taskId: z.string().min(1) });
export type TaskClaimRequest = z.infer<typeof TaskClaimRequestSchema>;

export const RunStartRequestSchema = z.object({ taskId: z.string().min(1) });
export type RunStartRequest = z.infer<typeof RunStartRequestSchema>;

/**
 * A `fileName` must stay inside the run dir / worktree root: reject absolute
 * paths, `.`/`..` traversal, and null bytes at the boundary (D8b defense in
 * depth; the handler must still contain the resolved path). Subdirectories are
 * allowed so worktree files can be browsed.
 */
function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) {
    return false;
  }
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }
  return !value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

export const RunFileReadRequestSchema = z.object({
  fileName: z.string().min(1).refine(isSafeRelativePath, { message: 'fileName must be a safe relative path' }),
  location: RunFileLocationSchema.default('runDir')
});
export type RunFileReadRequest = z.infer<typeof RunFileReadRequestSchema>;

export const RunActionRequestSchema = z.object({ action: ToolActionSchema });
export type RunActionRequest = z.infer<typeof RunActionRequestSchema>;

/** Config save reuses the full config schema. */
export const ConfigSaveRequestSchema = BeaverConfigSchema;

/**
 * Registry of request schemas keyed by API route, so the daemon can look up
 * "which schema validates this endpoint's body" without a hand-written switch.
 */
export const REQUEST_SCHEMAS = {
  configSet: ConfigSaveRequestSchema,
  repoValidate: RepoValidateRequestSchema,
  tasksClaim: TaskClaimRequestSchema,
  runsStart: RunStartRequestSchema,
  runFileRead: RunFileReadRequestSchema,
  runActions: RunActionRequestSchema
} as const;

export type RequestSchemaKey = keyof typeof REQUEST_SCHEMAS;

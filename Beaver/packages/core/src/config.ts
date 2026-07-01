import { z } from 'zod';

/**
 * Beaver configuration contract. Config keys are stable English and shared by
 * daemon (validation), CLI (`config get/set`), and renderer (settings screen).
 *
 * Storage defaults point at `~/.beaver`. The concrete root is resolved via
 * `resolveBeaverHome()` at runtime; the `~/.beaver` strings here are only the
 * declarative defaults for a fresh config file.
 */

export const SubmoduleUpdateOptionsSchema = z.object({
  jobs: z.number().int().positive().default(8),
  filter: z.string().min(1).nullable().default('blob:none'),
  depth: z.number().int().positive().nullable().default(null),
  recursive: z.boolean().default(false)
});

export const AgentResumeConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([])
});

export const AgentProfileSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  blockingExitCodes: z.array(z.number().int()).default([]),
  resume: AgentResumeConfigSchema.optional()
});

export const VerifierConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  blockingExitCodes: z.array(z.number().int()).default([])
});

/**
 * Fixed operational scripts surfaced as buttons/actions. Optional and
 * machine-specific: no default paths are baked into the contract, so a fresh
 * config never leaks a particular developer's filesystem.
 */
export const AutomationConfigSchema = z.object({
  pipelineStatusScript: z.string().min(1).optional(),
  gitShipFastGateScript: z.string().min(1).optional(),
  gitShipPushSnapshotScript: z.string().min(1).optional()
});

export const LocalJsonTaskSourceConfigSchema = z.object({
  type: z.literal('localJson'),
  path: z.string().min(1).default('~/.beaver/tasks/local-tasks.json')
});

export const LarkBaseProjectSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  repoPath: z.string().optional(),
  baseBranch: z.string().min(1).optional(),
  requiredSubmodules: z.array(z.string()).optional(),
  agentProfile: z.string().min(1).optional()
});

export const LarkBaseTaskSourceConfigSchema = z.object({
  type: z.literal('larkBase'),
  projects: z.array(LarkBaseProjectSchema).default([]),
  larkCliBinary: z.string().min(1).default('lark-cli'),
  statePath: z.string().min(1).default('~/.beaver/lark-base/projects.json'),
  syncIntervalMinutes: z.number().int().min(0).default(0),
  includeDone: z.boolean().default(false),
  historyPages: z.number().int().positive().max(20).default(4)
});

export const TaskSourceConfigSchema = z.discriminatedUnion('type', [
  LocalJsonTaskSourceConfigSchema,
  LarkBaseTaskSourceConfigSchema
]);

export const BeaverConfigSchema = z
  .object({
    workspaceRoot: z.string().min(1).default('~/.beaver/workspaces'),
    defaultRepoPath: z.string().default(''),
    gitBinary: z.string().min(1).default('git'),
    defaultAgentProfile: z.string().min(1).default('generic'),
    agentProfiles: z.record(AgentProfileSchema).default({}),
    verifier: VerifierConfigSchema.optional(),
    automation: AutomationConfigSchema.optional(),
    submoduleUpdate: SubmoduleUpdateOptionsSchema.default({
      jobs: 8,
      filter: 'blob:none',
      depth: null,
      recursive: false
    }),
    taskSource: TaskSourceConfigSchema.default({
      type: 'localJson',
      path: '~/.beaver/tasks/local-tasks.json'
    })
  })
  .superRefine((config, context) => {
    const profiles = Object.keys(config.agentProfiles);
    if (profiles.length > 0 && !config.agentProfiles[config.defaultAgentProfile]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultAgentProfile'],
        message: `defaultAgentProfile "${config.defaultAgentProfile}" is not defined in agentProfiles`
      });
    }
  });

export type BeaverConfig = z.infer<typeof BeaverConfigSchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type VerifierConfig = z.infer<typeof VerifierConfigSchema>;
export type TaskSourceConfig = z.infer<typeof TaskSourceConfigSchema>;
export type SubmoduleUpdateOptions = z.infer<typeof SubmoduleUpdateOptionsSchema>;

/** Input contract for a local-tasks.json entry. */
export const LocalTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string()).default([]),
  repoPath: z.string().default(''),
  baseBranch: z.string().min(1).default('main'),
  requiredSubmodules: z.array(z.string()).default([]),
  agentProfile: z.string().min(1).default('generic'),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  assignee: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export type LocalTask = z.infer<typeof LocalTaskSchema>;

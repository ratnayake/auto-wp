import { z } from 'zod';

/**
 * MCP tool catalogue shared by apps/mcp-server and e2e. Names use `[a-z_]` only (Claude tool-name rules
 * forbid dots). Tools marked `gated` require a human approval (planHash + MCP elicitation) and must never be
 * allowlisted in client permission settings.
 */

const siteId = z.string().describe('Site id from sites_list');
const dryRun = z.boolean().default(false).describe('Return the operations without changing anything');

export const toolInputSchemas = {
  sites_list: z.object({}),
  site_probe: z.object({ siteId }),
  backup_create: z.object({ siteId, dryRun, pull: z.boolean().default(true) }),
  backup_list: z.object({ siteId }),
  backup_verify: z.object({ siteId, backupId: z.string(), deep: z.boolean().default(false) }),
  backup_pull: z.object({ siteId, backupId: z.string() }),
  updates_check: z.object({ siteId }),
  updates_plan: z.object({
    siteId,
    only: z.array(z.string()).optional().describe('type:slug keys to include'),
  }),
  updates_apply: z.object({
    siteId,
    backupId: z.string().describe('A backup verified within the policy window'),
    only: z.array(z.string()).optional(),
    allowCoreMajor: z.boolean().default(false),
    dryRun,
  }),
  run_status: z.object({ runId: z.string() }),
  site_snapshot: z.object({ siteId, label: z.string().default('manual') }),
  site_compare: z.object({ siteId, beforeSnapshotId: z.string(), afterSnapshotId: z.string().optional() }),
  report_generate: z.object({ runId: z.string(), format: z.enum(['md', 'html', 'json']).default('md') }),
  maintenance_set: z.object({ siteId, enabled: z.boolean() }),
  restore_plan: z.object({
    siteId,
    backupId: z.string(),
    scope: z.enum(['full', 'db', 'files']).default('full'),
  }),
  restore_execute: z.object({ siteId, planHash: z.string() }),
  backup_prune: z.object({ siteId, keep: z.number().int().min(1).default(3), dryRun }),
  audit_tail: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export const TOOL_NAMES = Object.keys(toolInputSchemas) as ToolName[];

export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'sites_list',
  'site_probe',
  'backup_list',
  'backup_verify',
  'updates_check',
  'updates_plan',
  'run_status',
  'site_snapshot',
  'site_compare',
  'report_generate',
  'audit_tail',
];
export const GATED_TOOLS: readonly ToolName[] = ['restore_execute', 'backup_prune'];
/** Tools that start an async run and return `{ runId }` immediately; poll with run_status. */
export const ASYNC_TOOLS: readonly ToolName[] = ['backup_create', 'updates_apply', 'restore_execute'];

export const RUN_REPORT_RESOURCE = 'autowp://runs/{runId}/report.md';

import { createHash } from 'node:crypto';
import {
  GATED_TOOLS,
  type ItemVulnAssessment,
  itemKey,
  READ_ONLY_TOOLS,
  RUN_REPORT_RESOURCE,
  type SiteConnection,
  TOOL_NAMES,
  TOOL_VERSION,
  type ToolName,
  toolInputSchemas,
  type UpdateItem,
} from '@auto-wp/contracts';
import { PolicyEngine } from '@auto-wp/safety';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { ApprovalRefused, confirmationCode, requestApproval } from './approval.js';
import type { Services } from './container.js';
import { type Notify, RunManager, UserError } from './runs.js';

type Args<K extends ToolName> = z.infer<(typeof toolInputSchemas)[K]>;
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

interface Out {
  text: string;
  data: Record<string, unknown>;
}
interface Ctx {
  actor: string;
  notify: Notify;
  extra: Extra;
}
type Handlers = { [K in ToolName]: (args: Args<K>, ctx: Ctx) => Promise<Out> };

const META: Record<ToolName, { title: string; description: string; idempotent?: boolean; local?: boolean }> =
  {
    sites_list: {
      title: 'List sites',
      description: 'List configured WordPress sites (ids, names, URLs, transport).',
      local: true,
    },
    site_probe: {
      title: 'Probe site',
      description: 'Connect to a site and report its capabilities (PHP, WP-CLI, binaries, disk).',
    },
    backup_create: {
      title: 'Create backup',
      description:
        'Back up database and files into the site backup folder, then auto-verify. Async: returns { runId }; poll run_status.',
    },
    backup_list: { title: 'List backups', description: 'List backups that exist on the site.' },
    backup_verify: {
      title: 'Verify backup',
      description:
        'Verify a backup (integrity; deep=true also test-restores). Records the result used by updates_apply.',
    },
    backup_pull: {
      title: 'Pull backup',
      description: 'Copy a backup off-server to local storage.',
      idempotent: true,
    },
    updates_check: { title: 'Check updates', description: 'Detect pending core, theme and plugin updates.' },
    updates_plan: {
      title: 'Plan updates',
      description: 'Show which updates would be applied and which are held back, and why.',
    },
    updates_apply: {
      title: 'Apply updates',
      description:
        'Apply planned updates one by one with health checks and per-item rollback. Requires a backup verified within the policy window. Async: returns { runId }; poll run_status.',
    },
    run_status: {
      title: 'Run status',
      description: 'Status, per-item results and recent progress of an async run.',
      local: true,
    },
    site_snapshot: {
      title: 'Health snapshot',
      description: 'Take a health snapshot (pages, status, errors) for later comparison.',
    },
    site_compare: {
      title: 'Compare snapshots',
      description: 'Compare two health snapshots (the second defaults to a fresh one).',
    },
    report_generate: {
      title: 'Generate report',
      description:
        'Render the report of a finished run: core, themes, updated plugins only, failures, vulnerabilities.',
      local: true,
    },
    maintenance_set: {
      title: 'Set maintenance mode',
      description: 'Enable or disable WordPress maintenance mode.',
      idempotent: true,
    },
    restore_plan: {
      title: 'Plan restore',
      description: 'Build a restore plan. Returns the planHash and steps; nothing is changed.',
      local: true,
    },
    restore_execute: {
      title: 'Execute restore',
      description:
        'DESTRUCTIVE. Restore a site from a planned backup after human approval (planHash). Async: returns { runId }.',
    },
    backup_prune: {
      title: 'Prune backups',
      description:
        'DESTRUCTIVE. Delete old backups keeping the newest N, after human approval. dryRun=true lists without approval.',
    },
    audit_tail: { title: 'Audit log', description: 'Most recent audit entries.', local: true },
  };

const NON_DESTRUCTIVE_MUTATIONS: readonly ToolName[] = ['backup_create', 'backup_pull', 'maintenance_set'];

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function result(out: Out): CallToolResult {
  return { content: [{ type: 'text', text: out.text }], structuredContent: out.data };
}
function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export interface BuiltServer {
  server: McpServer;
  runs: RunManager;
}

export function buildServer(services: Services, runs: RunManager = new RunManager(services)): McpServer {
  return buildServerWithRuns(services, runs).server;
}

/** Like buildServer but also exposes the RunManager (shared across HTTP sessions, awaited in tests). */
export function buildServerWithRuns(
  services: Services,
  runs: RunManager = new RunManager(services),
): BuiltServer {
  const s = services;
  const server = new McpServer(
    { name: 'auto-wp', version: TOOL_VERSION },
    {
      instructions:
        'Maintains WordPress sites. Typical flow: sites_list, backup_create (async, auto-verified), updates_plan, updates_apply (async), run_status, report_generate. restore_execute and backup_prune need human approval.',
    },
  );

  const approve = (
    ctx: Ctx,
    action: Parameters<typeof requestApproval>[2]['action'],
    siteId: string,
    summary: string,
    planHash: string,
  ) =>
    requestApproval(s, server, {
      action,
      siteId,
      summary,
      planHash,
      actor: ctx.actor,
      relatedRequestId: ctx.extra.requestId,
    });

  const handlers: Handlers = {
    async sites_list() {
      const sites = s.config.sites.map((x) => ({
        id: x.id,
        name: x.name,
        url: x.url,
        transport: x.transport.kind,
      }));
      return {
        text: sites.length
          ? sites.map((x) => `${x.id}: ${x.name} (${x.url}, ${x.transport})`).join('\n')
          : 'No sites configured.',
        data: { sites },
      };
    },

    async site_probe({ siteId }) {
      return withConn(siteId, async (_site, c) => {
        const caps = await c.probe();
        const wpVersion = await readWpVersion(c);
        return {
          text: `${siteId}: WordPress ${wpVersion ?? 'unknown'}, PHP ${caps.phpVersion}, shell=${caps.shell}, wp-cli=${caps.wpCli.available}, root ${caps.wpRoot}`,
          data: { capabilities: caps, ...(wpVersion ? { wpVersion } : {}) },
        };
      });
    },

    async backup_create({ siteId, dryRun, pull }, ctx) {
      const runId = await runs.startBackup(runs.site(siteId), { dryRun, pull }, ctx.notify);
      return started(runId, dryRun ? 'Backup dry run started' : 'Backup started (auto-verifies when done)');
    },

    async backup_list({ siteId }) {
      return withConn(siteId, async (site, c) => {
        const backups = await s.backup.list(site, c);
        const rows = backups.map((b) => {
          const v = runs.verifications.get(`${siteId}/${b.backupId}`);
          return {
            backupId: b.backupId,
            createdAt: b.createdAt,
            verified: v ? v.ok : null,
            verifiedAt: v?.verifiedAt,
          };
        });
        return {
          text: rows.length
            ? rows.map((r) => `${r.backupId} ${r.createdAt} verified=${r.verified ?? 'unknown'}`).join('\n')
            : 'No backups.',
          data: { backups: rows },
        };
      });
    },

    async backup_verify({ siteId, backupId, deep }) {
      return withConn(siteId, async (site, c) => {
        const v = await s.verifier.verify(site, c, backupId, { deep });
        runs.recordVerification(siteId, v);
        const bad = v.checks.filter((k) => !k.ok).map((k) => k.name);
        return {
          text: v.ok
            ? `Backup ${backupId} verified OK.`
            : `Backup ${backupId} FAILED verification: ${bad.join(', ') || 'unknown'}`,
          data: { verification: v },
        };
      });
    },

    async backup_pull({ siteId, backupId }) {
      return withConn(siteId, async (site, c) => {
        const r = await s.backup.pull(site, c, backupId);
        return { text: `Pulled ${backupId} to ${r.localDir}`, data: r };
      });
    },

    async updates_check({ siteId }) {
      return withConn(siteId, async (site, c) => {
        const { items, installedCore } = await runs.detectAndPlan(site, c);
        const assessments = await s.vulns.assess(items);
        const attributions = s.vulns.attributions();
        return {
          text: describeItems(items, assessments),
          data: { items, assessments, attributions, ...(installedCore ? { installedCore } : {}) },
        };
      });
    },

    async updates_plan({ siteId, only }) {
      return withConn(siteId, async (site, c) => {
        const { plan, installedCore } = await runs.detectAndPlan(site, c, only);
        return { text: describeItems(plan), data: { plan, ...(installedCore ? { installedCore } : {}) } };
      });
    },

    async updates_apply({ siteId, backupId, only, allowCoreMajor, dryRun }, ctx) {
      const site = runs.site(siteId);
      let coreNote = '';
      const runId = await runs.startUpdate(
        site,
        {
          backupId,
          only,
          allowCoreMajor,
          dryRun,
          approveCoreMajor: async () => {
            try {
              await approve(
                ctx,
                'update.core-major',
                siteId,
                `Allow a WordPress core MAJOR update on ${siteId} (backup ${backupId}).`,
                sha({ siteId, backupId, only, coreMajor: true }),
              );
              return true;
            } catch (err) {
              if (!(err instanceof ApprovalRefused)) throw err;
              coreNote = ` Core major update excluded: ${err.message}`;
              return false;
            }
          },
        },
        ctx.notify,
      );
      return started(runId, `${dryRun ? 'Update dry run' : 'Update'} started.${coreNote}`);
    },

    async run_status({ runId }) {
      const { run, recentProgress } = await runs.status(runId);
      const counts = run.results.map((r) => r.outcome);
      return {
        text: `Run ${runId} (${run.kind}): ${run.status}; ${run.results.length}/${run.plan.length} item(s) processed${run.error ? `; error: ${run.error}` : ''}`,
        data: { run, recentProgress, outcomes: counts },
      };
    },

    async site_snapshot({ siteId, label }) {
      return withConn(siteId, async (site, c) => {
        const snap = await s.health.snapshot(site, c, label);
        runs.snapshots.set(snap.snapshotId, snap);
        return {
          text: `Snapshot ${snap.snapshotId} taken (${snap.pages.length} page(s)).`,
          data: { snapshot: snap },
        };
      });
    },

    async site_compare({ siteId, beforeSnapshotId, afterSnapshotId }) {
      return withConn(siteId, async (site, c) => {
        const before = runs.snapshots.get(beforeSnapshotId);
        if (!before || before.siteId !== siteId)
          throw new UserError(`Unknown snapshot "${beforeSnapshotId}" for site ${siteId}.`);
        let after = afterSnapshotId ? runs.snapshots.get(afterSnapshotId) : undefined;
        if (afterSnapshotId && (!after || after.siteId !== siteId))
          throw new UserError(`Unknown snapshot "${afterSnapshotId}" for site ${siteId}.`);
        if (!after) {
          after = await s.health.snapshot(site, c, 'compare');
          runs.snapshots.set(after.snapshotId, after);
        }
        const cmp = await s.health.compare(before, after, runs.policy(site).thresholds);
        const problems = cmp.pages.flatMap((p) => p.problems);
        return {
          text: cmp.ok
            ? 'No regressions detected.'
            : `Regressions: ${[...problems, ...cmp.newLogErrors].join('; ')}`,
          data: { comparison: cmp, afterSnapshotId: after.snapshotId },
        };
      });
    },

    async report_generate({ runId, format }) {
      const report = await runs.report(runId);
      const text = await s.reporter.render(report, format);
      return { text, data: { runId, format, report } };
    },

    async maintenance_set({ siteId, enabled }, ctx) {
      const site = runs.site(siteId);
      if (new PolicyEngine(runs.policy(site)).requiresApproval('maintenance.set')) {
        await approve(
          ctx,
          'maintenance.set',
          siteId,
          `Set maintenance mode ${enabled ? 'ON' : 'OFF'} for ${siteId}.`,
          sha({ siteId, enabled }),
        );
      }
      return withConn(siteId, async (_site, c) => {
        const r = await c.call('wp.maintenance', { enabled });
        return { text: `Maintenance mode ${r.enabled ? 'enabled' : 'disabled'} on ${siteId}.`, data: r };
      });
    },

    async restore_plan({ siteId, backupId, scope }) {
      return withConn(siteId, async (site, c) => {
        const plan = await s.restore.plan(site, c, backupId, scope);
        runs.restorePlans.set(plan.planHash, plan);
        return {
          text: `Restore plan ${plan.planHash} (confirmation code ${confirmationCode(plan.planHash)}):\n${plan.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}`,
          data: { plan },
        };
      });
    },

    async restore_execute({ siteId, planHash }, ctx) {
      const site = runs.site(siteId);
      const plan = runs.restorePlans.get(planHash);
      if (!plan || plan.siteId !== siteId) {
        throw new UserError('Unknown planHash for this site. Call restore_plan first and pass its planHash.');
      }
      const approval = await approve(
        ctx,
        'restore.execute',
        siteId,
        `RESTORE ${siteId} from backup ${plan.backupId} (${plan.scope}). This overwrites the live site.\nSteps: ${plan.steps.join('; ')}`,
        plan.planHash,
      );
      const runId = await runs.startRestore(site, plan, approval, ctx.notify);
      return started(runId, 'Restore started');
    },

    async backup_prune({ siteId, keep, dryRun }, ctx) {
      return withConn(siteId, async (site, c) => {
        const preview = await s.backup.prune(site, c, keep, { dryRun: true });
        if (dryRun || preview.removed.length === 0) {
          return {
            text: `${dryRun ? 'Would remove' : 'Nothing to remove;'} ${preview.removed.length} backup(s): ${preview.removed.join(', ') || '-'}`,
            data: { removed: preview.removed, dryRun: true },
          };
        }
        await approve(
          ctx,
          'backup.prune',
          siteId,
          `DELETE ${preview.removed.length} backup(s) on ${siteId}, keeping the newest ${keep}: ${preview.removed.join(', ')}`,
          sha({ siteId, keep, removed: preview.removed }),
        );
        // Backups may have changed while waiting for the human: only delete exactly what was approved.
        const recheck = await s.backup.prune(site, c, keep, { dryRun: true });
        if (JSON.stringify(recheck.removed) !== JSON.stringify(preview.removed)) {
          throw new UserError(
            'Backups changed while awaiting approval; re-run backup_prune to review the new list.',
          );
        }
        const done = await s.backup.prune(site, c, keep, { dryRun: false });
        return {
          text: `Removed ${done.removed.length} backup(s): ${done.removed.join(', ')}`,
          data: { removed: done.removed, dryRun: false },
        };
      });
    },

    async audit_tail({ limit }) {
      const entries = await s.audit.tail(limit);
      return {
        text:
          entries.map((e) => `${e.ts} ${e.actor} ${e.action}${e.siteId ? ` ${e.siteId}` : ''}`).join('\n') ||
          'Audit log is empty.',
        data: { entries },
      };
    },
  };

  async function withConn(
    siteId: string,
    fn: (
      site: ReturnType<RunManager['site']>,
      c: Awaited<ReturnType<Services['connectionFactory']['open']>>,
    ) => Promise<Out>,
  ) {
    const site = runs.site(siteId);
    const c = await s.connectionFactory.open(site);
    try {
      return await fn(site, c);
    } finally {
      await c.close().catch(() => {});
    }
  }

  for (const name of TOOL_NAMES) {
    const meta = META[name];
    const readOnly = READ_ONLY_TOOLS.includes(name);
    const gated = GATED_TOOLS.includes(name);
    const destructive = !readOnly && (gated || !NON_DESTRUCTIVE_MUTATIONS.includes(name));
    const handler = handlers[name] as (args: unknown, ctx: Ctx) => Promise<Out>;
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: toolInputSchemas[name].shape,
        annotations: {
          title: meta.title,
          readOnlyHint: readOnly,
          ...(readOnly ? {} : { destructiveHint: destructive }),
          idempotentHint: readOnly || !!meta.idempotent,
          openWorldHint: !meta.local,
        },
      },
      async (args: unknown, extra: Extra): Promise<CallToolResult> => {
        const a = (args ?? {}) as { siteId?: string; dryRun?: boolean };
        const actor = extra.authInfo?.clientId ?? s.defaultActor ?? 'unknown';
        const token = extra._meta?.progressToken;
        const notify: Notify = (message, done, total) => {
          if (token === undefined) return;
          extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: done, total, message },
            })
            .catch(() => {}); // the request has usually completed by now; progress is best effort
        };
        let outcome = 'ok';
        let message: string | undefined;
        try {
          const out = await handler(args, { actor, notify, extra });
          return result(out);
        } catch (err) {
          if (err instanceof ApprovalRefused) {
            outcome = 'refused';
            message = err.message;
          } else if (err instanceof UserError) {
            outcome = 'rejected';
            message = err.message;
          } else {
            outcome = 'error';
            message = err instanceof Error ? err.message : String(err);
            s.logger.error({ tool: name, err: message }, 'tool failed');
          }
          return failure(message);
        } finally {
          await s.audit
            .append({
              ts: s.clock.now().toISOString(),
              actor,
              siteId: a.siteId,
              action: `tool:${name}`,
              dryRun: a.dryRun ?? false,
              data: { outcome, ...(outcome === 'ok' ? {} : { reason: message }) },
            })
            .catch((e) => s.logger.error({ err: String(e) }, 'audit append failed'));
        }
      },
    );
  }

  server.registerResource(
    'run-report',
    new ResourceTemplate(RUN_REPORT_RESOURCE, {
      list: async () => ({
        resources: (await s.runStore.list())
          .filter((r) => r.kind === 'update' && r.status !== 'running' && r.status !== 'pending')
          .map((r) => ({ uri: RUN_REPORT_RESOURCE.replace('{runId}', r.runId), name: `Report ${r.runId}` })),
      }),
    }),
    { title: 'Run report', description: 'Markdown report of a finished run', mimeType: 'text/markdown' },
    async (uri, variables) => {
      const runId = String(Array.isArray(variables.runId) ? variables.runId[0] : variables.runId);
      const text = await s.reporter.render(await runs.report(runId), 'md');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  return { server, runs };
}

function started(runId: string, prefix: string): Out {
  return { text: `${prefix}. runId=${runId}. Poll run_status.`, data: { runId } };
}

/** Installed WordPress version from `wp-includes/version.php` (no WordPress bootstrap); best effort. */
async function readWpVersion(c: SiteConnection): Promise<string | undefined> {
  try {
    const src = (await c.readFile('wp-includes/version.php')).toString('utf8');
    return /\$wp_version\s*=\s*'([^']+)'/.exec(src)?.[1];
  } catch {
    return undefined;
  }
}

function describeItems(items: UpdateItem[], assessments: ItemVulnAssessment[] = []) {
  if (items.length === 0) return 'Everything is up to date.';
  const vulnsOf = new Map(assessments.map((a) => [itemKey(a.item), a]));
  return items
    .map((i) => {
      const a = vulnsOf.get(itemKey(i));
      const ids = (vs: ItemVulnAssessment['affectingOld']) => vs.map((v) => v.cve ?? v.id).join(', ');
      const vuln = !a
        ? ''
        : a.affectingOld.length
          ? `; vulnerable: ${ids(a.affectingOld)}${a.stillAffectingNew.length ? ` (still affects ${i.newVersion}: ${ids(a.stillAffectingNew)})` : ''}`
          : a.lookupFailed?.old
            ? '; vulnerability lookup failed'
            : '';
      return `${itemKey(i)} ${i.currentVersion} -> ${i.newVersion}${i.heldReason ? ` (held: ${i.heldReason})` : ''}${vuln}`;
    })
    .join('\n');
}

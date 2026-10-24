import { randomUUID } from 'node:crypto';
import {
  type ApprovalResult,
  type BackupManifest,
  type HealthSnapshot,
  type ItemResult,
  itemKey,
  type Policy,
  PolicySchema,
  type Report,
  type RestorePlan,
  type RunRecord,
  type SiteConfig,
  type SiteConnection,
  type VerificationResult,
} from '@auto-wp/contracts';
import type { Services } from './container.js';
import { buildReport, type RunExtras } from './report.js';

/** An error whose message is meant for the MCP caller (precondition failures, unknown ids). */
export class UserError extends Error {
  override name = 'UserError';
}

export type Notify = (message: string, done: number, total?: number) => void;
const noop: Notify = () => {};

const MAX_PROGRESS = 200;
const RECENT_PROGRESS = 20;

/**
 * Owns async runs (backup_create, updates_apply, restore_execute) and the in-process state they share:
 * backup verifications, health snapshots, restore plans and per-run extras. In-process state is lost on
 * restart; a backup must then be re-verified before updates_apply (fail-safe).
 */
export class RunManager {
  readonly verifications = new Map<string, VerificationResult>();
  readonly snapshots = new Map<string, HealthSnapshot>();
  readonly restorePlans = new Map<string, RestorePlan>();
  private readonly extras = new Map<string, RunExtras>();
  private readonly busy = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(private readonly s: Services) {}

  site(siteId: string): SiteConfig {
    const site = this.s.config.sites.find((x) => x.id === siteId);
    if (!site) {
      const known = this.s.config.sites.map((x) => x.id).join(', ') || '(none)';
      throw new UserError(`Unknown siteId "${siteId}". Known sites: ${known}. Use sites_list.`);
    }
    return site;
  }

  policy(site: SiteConfig): Policy {
    // Contract gap: zod 4 may fill defaults into a partial per-site policy, which would clobber the global
    // policy. Treat a site value equal to the schema default as "not overridden".
    const defaults = PolicySchema.parse({}) as Record<string, unknown>;
    const overrides = Object.fromEntries(
      Object.entries(site.policy ?? {}).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k])),
    );
    return PolicySchema.parse({ ...this.s.config.policy, ...overrides });
  }

  /** Resolves when all background runs have finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  recordVerification(siteId: string, v: VerificationResult): void {
    this.verifications.set(`${siteId}/${v.backupId}`, v);
  }

  // ---- backup ---------------------------------------------------------------------------------

  async startBackup(
    site: SiteConfig,
    o: { dryRun: boolean; pull: boolean },
    notify: Notify = noop,
  ): Promise<string> {
    const c = await this.s.connectionFactory.open(site);
    return this.launch(
      site,
      c,
      'backup',
      { dryRun: o.dryRun },
      async (run, extras, log) => {
        log('creating backup');
        const manifest: BackupManifest = await this.s.backup.create(site, c, {
          dryRun: o.dryRun,
          pull: o.pull,
          onProgress: log,
        });
        run.backupId = manifest.backupId;
        extras.backup = manifest;
        if (o.dryRun) {
          log('dry run: backup not written, verification skipped');
          return;
        }
        log('verifying backup');
        const v = await this.s.verifier.verify(site, c, manifest.backupId);
        extras.verification = v;
        this.recordVerification(site.id, v);
        if (!v.ok) {
          run.status = 'failed';
          run.error = `backup ${manifest.backupId} was created but failed verification; do not rely on it`;
        }
      },
      notify,
    );
  }

  // ---- updates --------------------------------------------------------------------------------

  /** Throws UserError unless backupId exists and was verified OK within policy.backupMaxAgeMinutes. */
  async assertBackupReady(site: SiteConfig, c: SiteConnection, backupId: string): Promise<void> {
    const maxAge = this.policy(site).backupMaxAgeMinutes;
    const hint = `Run backup_create (it verifies automatically) or backup_verify for site "${site.id}", then retry with that backupId.`;
    const backups = await this.s.backup.list(site, c);
    if (!backups.some((b) => b.backupId === backupId)) {
      throw new UserError(`Backup "${backupId}" does not exist for site "${site.id}". ${hint}`);
    }
    const v = this.verifications.get(`${site.id}/${backupId}`);
    if (!v || !v.ok) {
      throw new UserError(`Backup "${backupId}" has no passing verification. ${hint}`);
    }
    const ageMin = (this.s.clock.now().getTime() - new Date(v.verifiedAt).getTime()) / 60_000;
    if (!Number.isFinite(ageMin) || ageMin < -5 || ageMin > maxAge) {
      throw new UserError(
        `Backup "${backupId}" was verified ${Math.round(ageMin)} minutes ago; policy allows ${maxAge}. ${hint}`,
      );
    }
  }

  async startUpdate(
    site: SiteConfig,
    o: {
      backupId: string;
      only?: string[];
      allowCoreMajor: boolean;
      /** Called after the backup precondition passes; resolves true only when a human approved. */
      approveCoreMajor: () => Promise<boolean>;
      dryRun: boolean;
    },
    notify: Notify = noop,
  ): Promise<string> {
    const c = await this.s.connectionFactory.open(site);
    try {
      if (!o.dryRun) await this.assertBackupReady(site, c, o.backupId);
    } catch (err) {
      await c.close().catch(() => {});
      throw err;
    }
    const policy = this.policy(site);
    let coreMajorApproved = false;
    try {
      coreMajorApproved = o.allowCoreMajor && !o.dryRun && (await o.approveCoreMajor());
    } catch (err) {
      await c.close().catch(() => {});
      throw err;
    }
    return this.launch(
      site,
      c,
      'update',
      { dryRun: o.dryRun, backupId: o.backupId },
      async (run, extras, log) => {
        log('health snapshot (before)');
        const before = await this.s.health.snapshot(site, c, 'before');
        this.snapshots.set(before.snapshotId, before);
        run.baseline = before;
        await this.persist(run);

        log('detecting updates');
        const caps = await c.probe();
        let items = await this.s.inventory.detect(c);
        if (o.only) {
          const keys = new Set(o.only);
          items = items.filter((i) => keys.has(itemKey(i)));
        }
        const planned = this.s.inventory.plan(items, caps, policy).map((i) =>
          i.type === 'core' && i.isMajor && !coreMajorApproved
            ? {
                ...i,
                heldReason: i.heldReason ?? 'core major update needs allowCoreMajor and human approval',
              }
            : i,
        );
        run.plan = planned;
        await this.persist(run);

        const held = planned.filter((i) => i.heldReason);
        const toApply = planned.filter((i) => !i.heldReason);
        const now = () => this.s.clock.now().toISOString();
        for (const i of held) {
          run.results.push({
            item: i,
            outcome: 'held',
            startedAt: now(),
            finishedAt: now(),
            error: i.heldReason,
            operations: [],
          });
        }
        log(`${toApply.length} item(s) to apply, ${held.length} held`);

        for await (const r of this.s.updater.apply(site, c, toApply, {
          runId: run.runId,
          dryRun: o.dryRun,
          baseline: before,
          policy,
        })) {
          run.results.push(r);
          log(`${itemKey(r.item)}: ${r.outcome}`, run.results.length, planned.length);
          await this.persist(run);
        }

        if (!o.dryRun) {
          log('health snapshot (after)');
          const after = await this.s.health.snapshot(site, c, 'after');
          this.snapshots.set(after.snapshotId, after);
          run.final = await this.s.health.compare(before, after, policy.thresholds);
          extras.comparison = run.final;
        }
        log('assessing vulnerabilities');
        extras.assessments = await this.s.vulns.assess(planned);
        extras.attributions = this.s.vulns.attributions();

        if (run.results.some((r: ItemResult) => r.outcome === 'failed-rollback-failed')) {
          run.status = 'needs-restore';
          run.error = 'a rollback failed; use restore_plan with the verified backup';
        } else if (run.final && !run.final.ok) {
          run.error = 'post-update site comparison reported problems; review report_generate output';
        }
      },
      notify,
    );
  }

  // ---- restore --------------------------------------------------------------------------------

  async startRestore(site: SiteConfig, plan: RestorePlan, approval: ApprovalResult, notify: Notify = noop) {
    const c = await this.s.connectionFactory.open(site);
    return this.launch(
      site,
      c,
      'restore',
      { dryRun: false, backupId: plan.backupId },
      async (run, extras, log) => {
        log(`restoring backup ${plan.backupId} (${plan.scope})`);
        const v = await this.s.restore.execute(site, c, plan, approval);
        extras.verification = v;
        if (!v.ok) {
          run.status = 'needs-restore';
          run.error = 'post-restore verification failed';
        }
      },
      notify,
    );
  }

  // ---- status / report ------------------------------------------------------------------------

  async status(runId: string): Promise<{ run: RunRecord; recentProgress: string[] }> {
    const run = await this.s.runStore.get(runId);
    if (!run) throw new UserError(`Unknown runId "${runId}".`);
    return { run, recentProgress: (this.extras.get(runId)?.progress ?? []).slice(-RECENT_PROGRESS) };
  }

  async report(runId: string): Promise<Report> {
    const run = await this.s.runStore.get(runId);
    if (!run) throw new UserError(`Unknown runId "${runId}".`);
    if (run.status === 'pending' || run.status === 'running') {
      throw new UserError(`Run ${runId} is still ${run.status}; poll run_status until it finishes.`);
    }
    const extras = this.extras.get(runId) ?? emptyExtras();
    return buildReport(run, extras, this.site(run.siteId), this.s.clock.now().toISOString());
  }

  // ---- internals ------------------------------------------------------------------------------

  private persist(run: RunRecord): Promise<void> {
    return this.s.runStore.save(run);
  }

  private async launch(
    site: SiteConfig,
    c: SiteConnection,
    kind: RunRecord['kind'],
    init: { dryRun: boolean; backupId?: string },
    work: (
      run: RunRecord,
      extras: RunExtras,
      log: (m: string, done?: number, total?: number) => void,
    ) => Promise<void>,
    notify: Notify,
  ): Promise<string> {
    if (this.busy.has(site.id)) {
      await c.close().catch(() => {});
      throw new UserError(`Site "${site.id}" already has a run in progress. Poll run_status or wait.`);
    }
    this.busy.add(site.id);
    const run: RunRecord = {
      runId: `run-${randomUUID().slice(0, 12)}`,
      siteId: site.id,
      kind,
      backupId: init.backupId,
      dryRun: init.dryRun,
      plan: [],
      results: [],
      status: 'running',
      startedAt: this.s.clock.now().toISOString(),
    };
    const extras = emptyExtras();
    try {
      await this.persist(run);
    } catch (err) {
      this.busy.delete(site.id);
      await c.close().catch(() => {});
      throw err;
    }
    this.extras.set(run.runId, extras);

    let counter = 0;
    const log = (message: string, done?: number, total?: number) => {
      extras.progress.push(message);
      if (extras.progress.length > MAX_PROGRESS) extras.progress.shift();
      notify(message, done ?? ++counter, total);
    };

    const task = (async () => {
      try {
        await work(run, extras, log);
        if (run.status === 'running') run.status = 'done';
      } catch (err) {
        run.status = 'failed';
        run.error = err instanceof Error ? err.message : String(err);
        this.s.logger.error({ runId: run.runId, siteId: site.id, err: run.error }, 'run failed');
      } finally {
        run.finishedAt = this.s.clock.now().toISOString();
        this.busy.delete(site.id);
        await c.close().catch(() => {});
        await this.persist(run).catch((e) => this.s.logger.error({ err: String(e) }, 'persist failed'));
        await this.s.audit
          .append({
            ts: run.finishedAt,
            actor: 'run',
            siteId: site.id,
            action: `run:${kind}`,
            dryRun: init.dryRun,
            data: { runId: run.runId, status: run.status, error: run.error },
          })
          .catch(() => {});
      }
    })();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return run.runId;
  }
}

const emptyExtras = (): RunExtras => ({ assessments: [], attributions: [], progress: [] });

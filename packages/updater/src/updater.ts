import {
  type Clock,
  type HealthChecker,
  type ItemOutcome,
  type ItemResult,
  itemKey,
  type Logger,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type SiteConfig,
  type SiteConnection,
  type UpdateItem,
  type Updater,
  type UpdaterOptions,
} from '@auto-wp/contracts';
import { defaultNeedsDbSnapshot, type NeedsDbSnapshot } from './db-snapshot-policy.js';
import { type ItemContext, runItem } from './item-runner.js';
import { assertSafeId, backupRoot } from './paths.js';
import { Remote } from './remote.js';
import { randomBypassToken } from './token.js';
import { msg } from './util.js';

export interface DefaultUpdaterDeps {
  health: HealthChecker;
  runs: RunStore;
  logger: Logger;
  clock: Clock;
  /** Maintenance bypass token source (default: 32 random URL-safe chars). */
  randomToken?: () => string;
  needsDbSnapshot?: NeedsDbSnapshot;
  /** Default for `DefaultUpdaterOptions.stopOnFailure`. */
  stopOnFailure?: boolean;
  /** Injected for tests (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Post-rollback health check tries and pause between them (default 3 tries, 2000 ms apart). */
  rollbackHealthAttempts?: number;
  rollbackHealthDelayMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DefaultUpdaterOptions extends UpdaterOptions {
  /** Stop after any rolled-back failure (default false). A core failure always stops the run. */
  stopOnFailure?: boolean;
  /** Remote lock TTL (default 7200 s). */
  lockTtlSec?: number;
}

/** Outcomes that are not redone when a run is resumed. `skipped` items are retried. */
const FINAL: ReadonlySet<ItemOutcome> = new Set<ItemOutcome>([
  'updated',
  'held',
  'failed-rolled-back',
  'failed-rollback-failed',
  'dry-run',
]);

export class DefaultUpdater implements Updater {
  constructor(private readonly deps: DefaultUpdaterDeps) {}

  apply(
    site: SiteConfig,
    c: SiteConnection,
    plan: UpdateItem[],
    o: DefaultUpdaterOptions,
  ): AsyncIterable<ItemResult> {
    return this.run(site, c, plan, o);
  }

  private async *run(
    site: SiteConfig,
    c: SiteConnection,
    plan: UpdateItem[],
    o: DefaultUpdaterOptions,
  ): AsyncGenerator<ItemResult> {
    const { runs, logger, clock } = this.deps;
    const dryRun = o.dryRun ?? false;
    const stopOnFailure = o.stopOnFailure ?? this.deps.stopOnFailure ?? false;
    assertSafeId('runId', o.runId);

    const existing = await runs.get(o.runId);
    if (existing) {
      if (existing.siteId !== site.id || existing.kind !== 'update')
        throw new Error(`run ${o.runId} belongs to another site or kind`);
      if (existing.dryRun !== dryRun)
        throw new Error(`run ${o.runId} was created with dryRun=${existing.dryRun}`);
      if (existing.status === 'needs-restore')
        throw new Error(`run ${o.runId} needs a restore; refusing to resume it`);
      const sig = (items: UpdateItem[]) => items.map((i) => `${itemKey(i)}@${i.newVersion}`).join(',');
      if (sig(existing.plan) !== sig(plan))
        throw new Error(`run ${o.runId} was started with a different plan; use a new runId`);
    }
    const prior = new Map<string, ItemResult>();
    for (const r of existing?.results ?? []) if (FINAL.has(r.outcome)) prior.set(itemKey(r.item), r);

    const caps = await c.probe();
    const remote = new Remote(c, caps);
    const record: RunRecord = existing
      ? { ...existing, status: 'running', finishedAt: undefined, error: undefined }
      : {
          runId: o.runId,
          siteId: site.id,
          kind: 'update',
          dryRun,
          plan,
          results: [],
          baseline: o.baseline,
          status: 'running',
          startedAt: clock.now().toISOString(),
        };
    const results = new Map<string, ItemResult>(record.results.map((r) => [itemKey(r.item), r]));
    const persist = async (): Promise<void> => {
      record.results = plan.flatMap((i) => results.get(itemKey(i)) ?? []);
      await runs.save(record);
    };

    let locked = false;
    /** False until this call owns the run (lock held); a run we do not own is never written. */
    let owned = false;
    let status = 'done' as RunStatus;
    const stopFor = (item: UpdateItem, r: ItemResult, maintenanceOffFailed: boolean): string | undefined => {
      const key = itemKey(item);
      if (r.outcome === 'failed-rollback-failed') {
        status = 'needs-restore';
        return `run stopped: rollback of ${key} failed; site needs a restore`;
      }
      if (maintenanceOffFailed) {
        status = 'aborted';
        return `run stopped: maintenance mode could not be disabled after ${key}`;
      }
      if (r.outcome === 'failed-rolled-back' && (item.type === 'core' || stopOnFailure)) {
        status = 'aborted';
        return `run stopped after failed ${key} (rolled back)`;
      }
      return undefined;
    };
    try {
      if (!dryRun) {
        const lock = await c.call('lock.acquire', { runId: o.runId, ttlSec: o.lockTtlSec ?? 7200 });
        if (!lock.acquired)
          throw new Error(`site is locked by ${lock.holder ?? 'another run'} until ${lock.expiresAt ?? '?'}`);
        locked = true;
      }
      owned = true;
      await persist();

      if (existing && !dryRun) {
        // An interrupted run may have left maintenance mode on.
        await c.call('wp.maintenance', { enabled: false }).catch((e: unknown) => {
          logger.warn({ runId: o.runId, error: msg(e) }, 'could not clear maintenance mode on resume');
        });
      }

      const ctx: ItemContext = {
        site,
        remote,
        opts: o,
        runDir: `${backupRoot(site, caps)}/${o.runId}`,
        dbSizeMb: await this.dbSize(remote, o),
        health: this.deps.health,
        logger,
        clock,
        token: this.deps.randomToken ?? randomBypassToken,
        needsDb: this.deps.needsDbSnapshot ?? defaultNeedsDbSnapshot,
        sleep: this.deps.sleep ?? defaultSleep,
        rollbackHealth: {
          attempts: this.deps.rollbackHealthAttempts ?? 3,
          delayMs: this.deps.rollbackHealthDelayMs ?? 2000,
        },
      };

      let stopReason: string | undefined;
      for (const item of plan) {
        const key = itemKey(item);
        const done = prior.get(key);
        if (done) {
          // Replayed results re-apply the stop rules, so resuming cannot bypass a core-failure stop.
          stopReason ??= stopFor(item, done, false);
          if (stopReason) record.error = stopReason;
          yield done;
          continue;
        }
        const now = clock.now().toISOString();
        if (item.heldReason) {
          const r: ItemResult = {
            item,
            outcome: 'held',
            startedAt: now,
            finishedAt: now,
            error: item.heldReason,
            operations: [`held: ${item.heldReason}`],
          };
          results.set(key, r);
          await persist();
          yield r;
          continue;
        }
        if (stopReason) {
          const r: ItemResult = {
            item,
            outcome: 'skipped',
            startedAt: now,
            finishedAt: now,
            error: stopReason,
            operations: [],
          };
          results.set(key, r);
          await persist();
          yield r;
          continue;
        }

        logger.info({ runId: o.runId, item: key, dryRun }, 'processing item');
        const { result, maintenanceOffFailed } = await runItem(ctx, item);
        results.set(key, result);
        stopReason = stopFor(item, result, maintenanceOffFailed);
        if (stopReason) record.error = stopReason;
        record.status = status === 'needs-restore' ? 'needs-restore' : 'running';
        await persist();
        yield result;
      }
      record.status = status;
    } catch (e) {
      logger.error({ runId: o.runId, error: msg(e) }, 'update run aborted');
      if (owned) {
        record.status = record.status === 'needs-restore' ? 'needs-restore' : 'aborted';
        record.error = msg(e);
      }
      throw e;
    } finally {
      if (locked) {
        try {
          await c.call('lock.release', { runId: o.runId });
        } catch (e) {
          logger.error({ runId: o.runId, error: msg(e) }, 'failed to release site lock');
        }
      }
      if (owned) {
        // A consumer that stops iterating early leaves the run unfinished but resumable.
        if (record.status === 'running') record.status = 'aborted';
        record.finishedAt = clock.now().toISOString();
        try {
          await persist();
        } catch (e) {
          logger.error({ runId: o.runId, error: msg(e) }, 'failed to persist final run record');
        }
      }
    }
  }

  private async dbSize(remote: Remote, o: UpdaterOptions): Promise<number | undefined> {
    if (o.policy.dbSnapshot !== 'auto') return undefined;
    try {
      return await remote.dbSizeMb();
    } catch (e) {
      this.deps.logger.warn({ error: msg(e) }, 'could not measure DB size; assuming snapshots are needed');
      return undefined;
    }
  }
}

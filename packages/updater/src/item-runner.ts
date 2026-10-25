import { posix } from 'node:path';
import {
  type Clock,
  type ComparisonResult,
  type HealthChecker,
  type HealthSnapshot,
  ITEM_SNAPSHOT_DIR,
  type ItemOutcome,
  type ItemResult,
  type Logger,
  type SiteConfig,
  type UpdateItem,
  type UpdaterOptions,
} from '@auto-wp/contracts';
import type { NeedsDbSnapshot } from './db-snapshot-policy.js';
import { assertSafeItem, itemSnapshotBase } from './paths.js';
import type { DbSnapshot, Remote } from './remote.js';
import { msg } from './util.js';

export interface ItemContext {
  site: SiteConfig;
  remote: Remote;
  opts: UpdaterOptions;
  /** `<backup root>/<runId>`. */
  runDir: string;
  dbSizeMb: number | undefined;
  health: HealthChecker;
  logger: Logger;
  clock: Clock;
  token: () => string;
  needsDb: NeedsDbSnapshot;
  sleep: (ms: number) => Promise<void>;
  /**
   * Post-rollback health checks: tries and the pause between them. After a rollback, PHP opcache can keep
   * serving the broken code for a couple of seconds (`opcache.revalidate_freq`), so one failure is not final.
   */
  rollbackHealth: { attempts: number; delayMs: number };
}

export interface ItemRunResult {
  result: ItemResult;
  /** Maintenance mode could not be switched off: the caller must stop the run. */
  maintenanceOffFailed: boolean;
}

interface Targets {
  /** Paths (relative to wpRoot) archived in the item snapshot. */
  paths: string[];
  /** Paths removed before the snapshot is extracted on rollback (empty for core: files are overwritten). */
  removable: string[];
}

type Partial_ = Omit<ItemResult, 'item' | 'startedAt' | 'finishedAt' | 'operations'>;

export async function runItem(ctx: ItemContext, item: UpdateItem): Promise<ItemRunResult> {
  const startedAt = ctx.clock.now().toISOString();
  const ops: string[] = [];
  let maintenanceOffFailed = false;
  const finish = (r: Partial_): ItemRunResult => ({
    result: { item, startedAt, finishedAt: ctx.clock.now().toISOString(), operations: ops, ...r },
    maintenanceOffFailed,
  });
  const skipped = (error: string): ItemRunResult => {
    ctx.logger.warn({ item: `${item.type}:${item.slug}`, error }, 'item skipped');
    return finish({ outcome: 'skipped', error });
  };

  let targets: Targets;
  try {
    assertSafeItem(item);
    targets = await itemTargets(ctx.remote, item);
  } catch (e) {
    return skipped(msg(e));
  }

  const { remote } = ctx;
  const c = remote.c;
  const itemsDir = `${ctx.runDir}/${ITEM_SNAPSHOT_DIR}`;
  const base = `${itemsDir}/${itemSnapshotBase(item)}`;
  const archive = `${base}.tar.gz`;
  const wantDb = ctx.needsDb(item, ctx.dbSizeMb, ctx.opts.policy);
  const updateOps = describeUpdate(remote, item);

  if (ctx.opts.dryRun) {
    ops.push(`snapshot files ${targets.paths.join(' ')} -> ${archive}`);
    ops.push('maintenance on (with bypass token)');
    ops.push(
      wantDb ? `snapshot db -> ${base}.${remote.wpCli ? 'sql' : 'sql.gz'}` : 'snapshot db: skipped by policy',
    );
    ops.push(...updateOps);
    ops.push(`verify installed version = ${item.newVersion}`);
    ops.push('cache flush');
    ops.push('health quick check');
    const undo = item.type === 'core' ? 'overwrite core files' : `remove ${targets.removable.join(' ')}`;
    ops.push(
      `on failure: rollback (${undo}; extract ${archive}${wantDb ? '; db import' : ''}; cache flush; health quick check)`,
    );
    ops.push('maintenance off');
    return finish({ outcome: 'dry-run' });
  }

  // 1. Item snapshot. Nothing has been changed yet, so a failure here just skips the item. An existing
  // snapshot (left by an interrupted attempt of this run) is reused, never overwritten: it holds the
  // pre-update state, whereas the site may now be half-updated. Snapshots created by an attempt that ends
  // up skipped before anything changed are deleted again so a later resume cannot reuse stale data.
  const created: string[] = [];
  try {
    await c.mkdir(itemsDir, { recursive: true });
    if (await isFile(c, archive)) ops.push(`snapshot files: reusing ${archive}`);
    else {
      await remote.archive(archive, targets.paths);
      created.push(archive);
      ops.push(`snapshot files ${targets.paths.join(' ')} -> ${archive}`);
    }
  } catch (e) {
    return skipped(`snapshot failed: ${msg(e)}`);
  }

  const token = ctx.token();
  let outcome: Partial_;
  try {
    outcome = await updateAndCheck(
      ctx,
      item,
      targets,
      { archive, base, wantDb, created },
      updateOps,
      ops,
      token,
    );
  } finally {
    // 8. Always attempted, even after exceptions.
    try {
      await c.call('wp.maintenance', { enabled: false });
      ops.push('maintenance off');
    } catch (e) {
      maintenanceOffFailed = true;
      ops.push('maintenance off FAILED');
      ctx.logger.error(
        { item: `${item.type}:${item.slug}`, siteId: ctx.site.id, error: msg(e) },
        'MAINTENANCE MODE COULD NOT BE DISABLED: the site may still be showing the maintenance page',
      );
    }
  }
  if (outcome.outcome === 'skipped') for (const p of created) await c.remove(p).catch(() => undefined);
  if (maintenanceOffFailed) {
    const note = 'maintenance mode could not be disabled';
    outcome = { ...outcome, error: outcome.error ? `${outcome.error}; ${note}` : note };
  }
  return finish(outcome);
}

async function updateAndCheck(
  ctx: ItemContext,
  item: UpdateItem,
  targets: Targets,
  snap: { archive: string; base: string; wantDb: boolean; created: string[] },
  updateOps: string[],
  ops: string[],
  token: string,
): Promise<Partial_> {
  const { archive } = snap;
  const { remote, logger } = ctx;
  const key = `${item.type}:${item.slug}`;

  // Log fatals are judged per item: lines an earlier item (e.g. a rolled-back failure) wrote must not fail
  // this one, so the log offsets are taken now, before anything of this item changes.
  const itemBaseline = await withCurrentLogOffsets(ctx, ctx.opts.baseline);

  // 3. Maintenance on. If this fails nothing was updated; the caller still switches it off.
  try {
    await remote.c.call('wp.maintenance', { enabled: true, bypassToken: token });
    ops.push('maintenance on');
  } catch (e) {
    logger.warn({ item: key, error: msg(e) }, 'maintenance on failed; item skipped');
    return { outcome: 'skipped', error: `maintenance on failed: ${msg(e)}` };
  }

  // 2. DB snapshot, taken under maintenance so no writes land between the dump and the update.
  let dbSnap: DbSnapshot | undefined;
  try {
    if (snap.wantDb) {
      dbSnap = await existingDbSnapshot(remote.c, snap.base);
      if (dbSnap) ops.push(`snapshot db: reusing ${dbSnap.path}`);
      else {
        dbSnap = await remote.dbDump(snap.base, (reason) => {
          ops.push('snapshot db: wp db export failed, using the agent dump');
          logger.warn({ item: key, error: reason }, 'wp db export failed; falling back to agent db.dump');
        });
        snap.created.push(dbSnap.path);
        ops.push(`snapshot db -> ${dbSnap.path}`);
      }
    } else ops.push('snapshot db: skipped by policy');
  } catch (e) {
    logger.warn({ item: key, error: msg(e) }, 'db snapshot failed; item skipped');
    return { outcome: 'skipped', error: `db snapshot failed: ${msg(e)}` };
  }

  // 4. Update + verify.
  let failure: string | undefined;
  let installedVersion: string | undefined;
  let health: ComparisonResult | undefined;
  try {
    await applyUpdate(remote, item);
    ops.push(...updateOps);
    installedVersion = await remote.installedVersion(item.type, item.slug);
    ops.push(`verify installed version: ${installedVersion ?? 'unknown'}`);
    if (installedVersion !== item.newVersion)
      failure = `installed version ${installedVersion ?? 'unknown'} != expected ${item.newVersion}`;
  } catch (e) {
    failure = `update failed: ${msg(e)}`;
  }

  // 5-6. Cache flush + health.
  if (!failure) {
    await flushCache(ctx, ops, '');
    try {
      health = await ctx.health.quick(ctx.site, remote.c, itemBaseline, { bypassToken: token });
      ops.push(`health quick: ${health.ok ? 'ok' : 'FAILED'}`);
      if (!health.ok) failure = 'health check failed after update';
    } catch (e) {
      failure = `health check error: ${msg(e)}`;
    }
  }
  if (!failure) return { outcome: 'updated', installedVersion, health };

  // 7. Rollback.
  logger.warn({ item: key, error: failure }, 'update failed; rolling back');
  const rb = await rollback(ctx, token, item, targets, archive, dbSnap, ops);
  const outcome: ItemOutcome = rb.recovered ? 'failed-rolled-back' : 'failed-rollback-failed';
  if (rb.recovered) logger.warn({ item: key }, 'rollback succeeded');
  else logger.error({ item: key, error: rb.error }, 'ROLLBACK FAILED: site needs a restore');
  return {
    outcome,
    installedVersion: rb.installedVersion,
    health: rb.health ?? health,
    error: rb.error ? `${failure}; rollback: ${rb.error}` : failure,
  };
}

interface RollbackResult {
  recovered: boolean;
  health?: ComparisonResult;
  installedVersion?: string;
  error?: string;
}

async function rollback(
  ctx: ItemContext,
  token: string,
  item: UpdateItem,
  targets: Targets,
  archive: string,
  dbSnap: DbSnapshot | undefined,
  ops: string[],
): Promise<RollbackResult> {
  const { remote } = ctx;
  const c = remote.c;
  try {
    // Never delete anything unless the snapshot to restore from is really there.
    if (!(await isFile(c, archive))) throw new Error(`item snapshot ${archive} missing; nothing removed`);
    for (const p of targets.removable) {
      await c.remove(p, { recursive: true });
      ops.push(`rollback: remove ${p}`);
    }
    await remote.extract(archive, '.');
    ops.push(`rollback: extract ${archive}`);
    if (dbSnap) {
      await remote.dbImport(dbSnap);
      ops.push(`rollback: db import ${dbSnap.path}`);
    }
  } catch (e) {
    return { recovered: false, error: msg(e) };
  }
  await flushCache(ctx, ops, 'rollback: ');
  let installedVersion: string | undefined;
  try {
    installedVersion = await remote.installedVersion(item.type, item.slug);
    ops.push(`rollback: installed version ${installedVersion ?? 'unknown'}`);
  } catch (e) {
    ops.push(`rollback: version check failed: ${msg(e)}`);
  }
  const { attempts, delayMs } = ctx.rollbackHealth;
  let health: ComparisonResult | undefined;
  let healthError: string | undefined;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    if (attempt > 1) await ctx.sleep(delayMs);
    try {
      // Judge the rolled-back site by what it logs from now on: the fatals the failed update wrote (and any
      // a previous attempt provoked) are already in the logs and must not fail this check.
      const baseline = await withCurrentLogOffsets(ctx, ctx.opts.baseline);
      health = await ctx.health.quick(ctx.site, c, baseline, { bypassToken: token });
      healthError = undefined;
    } catch (e) {
      health = undefined;
      healthError = msg(e);
    }
    const label = healthError ? `error: ${healthError}` : health?.ok ? 'ok' : 'FAILED';
    ops.push(`rollback: health quick${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${label}`);
    if (health?.ok) break;
  }
  if (!health)
    return { recovered: false, installedVersion, error: `health check error after rollback: ${healthError}` };
  if (!health.ok)
    return {
      recovered: false,
      health,
      installedVersion,
      error: 'health check still failing after rollback',
    };
  if (installedVersion !== item.currentVersion)
    return {
      recovered: false,
      health,
      installedVersion,
      error: `installed version after rollback is ${installedVersion ?? 'unknown'}, expected ${item.currentVersion}`,
    };
  return { recovered: true, health, installedVersion };
}

/** The baseline with each log's offset moved to its current size (unreadable logs keep their offset). */
async function withCurrentLogOffsets(ctx: ItemContext, baseline: HealthSnapshot): Promise<HealthSnapshot> {
  const paths = [...new Set([...Object.keys(baseline.logOffsets), ...ctx.site.logFiles])];
  const logOffsets: Record<string, number> = { ...baseline.logOffsets };
  for (const path of paths) {
    try {
      logOffsets[path] = (await ctx.remote.c.call('logs.tail', { path, fromOffset: 0, maxBytes: 1 })).size;
    } catch (e) {
      if (/not.?found|ENOENT|no such file/i.test(msg(e))) logOffsets[path] = 0;
    }
  }
  return { ...baseline, logOffsets };
}

async function flushCache(ctx: ItemContext, ops: string[], prefix: string): Promise<void> {
  try {
    await ctx.remote.c.call('cache.flush', { opcache: true, objectCache: true });
    ops.push(`${prefix}cache flush`);
  } catch (e) {
    ops.push(`${prefix}cache flush failed (warning)`);
    ctx.logger.warn({ siteId: ctx.site.id, error: msg(e) }, 'cache flush failed');
  }
}

/**
 * WP-CLI argv for the update. Core pins `--version` (always a wordpress.org release). Plugins and themes do
 * not: `--version` makes WP-CLI download that version from wordpress.org, which fails for premium and
 * privately hosted packages; without it WP-CLI installs the package WordPress offered, and the installed
 * version is verified against `newVersion` afterwards.
 */
function wpCliUpdate(item: UpdateItem): string[][] {
  if (item.type === 'core')
    return [
      ['core', 'update', `--version=${item.newVersion}`],
      ['core', 'update-db'],
    ];
  return [[item.type, 'update', item.slug]];
}

async function applyUpdate(remote: Remote, item: UpdateItem): Promise<void> {
  if (remote.wpCli) {
    for (const args of wpCliUpdate(item)) await remote.wp(args, `wp ${args.slice(0, 2).join(' ')}`);
    return;
  }
  await remote.c.call('wp.upgrade', { type: item.type, slug: item.slug, version: item.newVersion });
}

function describeUpdate(remote: Remote, item: UpdateItem): string[] {
  if (remote.wpCli) return wpCliUpdate(item).map((a) => `wp ${a.join(' ')}`);
  return [`wp.upgrade ${item.type} ${item.slug} ${item.newVersion}`];
}

async function itemTargets(remote: Remote, item: UpdateItem): Promise<Targets> {
  const c = remote.c;
  if (item.type === 'core') {
    for (const d of ['wp-admin', 'wp-includes'])
      if ((await c.stat(d))?.type !== 'dir') throw new Error(`core directory ${d} not found`);
    const php = (await c.list('.'))
      .filter((e) => e.type === 'file')
      .map((e) => posix.basename(e.path))
      .filter((n) => n.endsWith('.php') && n !== 'wp-config.php')
      .sort();
    return { paths: ['wp-admin', 'wp-includes', ...php], removable: [] };
  }
  const dir = `wp-content/${item.type === 'plugin' ? 'plugins' : 'themes'}/${item.slug}`;
  if ((await c.stat(dir))?.type === 'dir') return { paths: [dir], removable: [dir] };
  // Single-file plugins such as hello.php.
  if (item.type === 'plugin' && (await isFile(c, `${dir}.php`)))
    return { paths: [`${dir}.php`], removable: [`${dir}.php`] };
  throw new Error(`${item.type} directory ${dir} not found`);
}

async function isFile(c: Remote['c'], path: string): Promise<boolean> {
  const st = await c.stat(path);
  return st?.type === 'file' && st.size > 0;
}

async function existingDbSnapshot(c: Remote['c'], base: string): Promise<DbSnapshot | undefined> {
  if (await isFile(c, `${base}.sql`)) return { path: `${base}.sql`, method: 'wpcli' };
  if (await isFile(c, `${base}.sql.gz`)) return { path: `${base}.sql.gz`, method: 'agent' };
  return undefined;
}

import { posix } from 'node:path';
import type {
  Clock,
  ComparisonResult,
  HealthChecker,
  ItemOutcome,
  ItemResult,
  Logger,
  SiteConfig,
  UpdateItem,
  UpdaterOptions,
} from '@auto-wp/contracts';
import type { NeedsDbSnapshot } from './db-snapshot-policy.js';
import { assertSafeItem, itemSnapshotBase } from './paths.js';
import type { DbSnapshot, Remote } from './remote.js';

/**
 * Site object handed to `HealthChecker.quick` while maintenance mode is on. `bypassCookie` carries the
 * maintenance bypass token so the checker can reach the real site (package-local extension of SiteConfig).
 */
export type SiteWithBypass = SiteConfig & { bypassCookie: string };

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

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  const itemsDir = `${ctx.runDir}/items`;
  const base = `${itemsDir}/${itemSnapshotBase(item)}`;
  const archive = `${base}.tar.gz`;
  const wantDb = ctx.needsDb(item, ctx.dbSizeMb, ctx.opts.policy);
  const updateOps = describeUpdate(remote, item);

  if (ctx.opts.dryRun) {
    ops.push(`snapshot files ${targets.paths.join(' ')} -> ${archive}`);
    ops.push(
      wantDb ? `snapshot db -> ${base}.${remote.wpCli ? 'sql' : 'sql.gz'}` : 'snapshot db: skipped by policy',
    );
    ops.push('maintenance on (with bypass token)');
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

  // 1-2. Snapshots. Nothing has been changed yet, so a failure here just skips the item. An existing
  // snapshot (from an interrupted attempt of this run) is reused, never overwritten: it holds the
  // pre-update state, whereas the site may now be half-updated.
  let dbSnap: DbSnapshot | undefined;
  try {
    await c.mkdir(itemsDir, { recursive: true });
    if (await isFile(c, archive)) ops.push(`snapshot files: reusing ${archive}`);
    else {
      await remote.archive(archive, targets.paths);
      ops.push(`snapshot files ${targets.paths.join(' ')} -> ${archive}`);
    }
    if (wantDb) {
      dbSnap = await existingDbSnapshot(c, base);
      if (dbSnap) ops.push(`snapshot db: reusing ${dbSnap.path}`);
      else {
        dbSnap = await remote.dbDump(base);
        ops.push(`snapshot db -> ${dbSnap.path}`);
      }
    } else ops.push('snapshot db: skipped by policy');
  } catch (e) {
    return skipped(`snapshot failed: ${msg(e)}`);
  }

  const token = ctx.token();
  const site: SiteWithBypass = { ...ctx.site, bypassCookie: token };
  let outcome: Partial_;
  try {
    outcome = await updateAndCheck(ctx, site, item, targets, archive, dbSnap, updateOps, ops, token);
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
  if (maintenanceOffFailed) {
    const note = 'maintenance mode could not be disabled';
    outcome = { ...outcome, error: outcome.error ? `${outcome.error}; ${note}` : note };
  }
  return finish(outcome);
}

async function updateAndCheck(
  ctx: ItemContext,
  site: SiteWithBypass,
  item: UpdateItem,
  targets: Targets,
  archive: string,
  dbSnap: DbSnapshot | undefined,
  updateOps: string[],
  ops: string[],
  token: string,
): Promise<Partial_> {
  const { remote, logger } = ctx;
  const key = `${item.type}:${item.slug}`;

  // 3. Maintenance on. If this fails nothing was updated; the caller still switches it off.
  try {
    await remote.c.call('wp.maintenance', { enabled: true, bypassToken: token });
    ops.push('maintenance on');
  } catch (e) {
    logger.warn({ item: key, error: msg(e) }, 'maintenance on failed; item skipped');
    return { outcome: 'skipped', error: `maintenance on failed: ${msg(e)}` };
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
      health = await ctx.health.quick(site, remote.c, ctx.opts.baseline);
      ops.push(`health quick: ${health.ok ? 'ok' : 'FAILED'}`);
      if (!health.ok) failure = 'health check failed after update';
    } catch (e) {
      failure = `health check error: ${msg(e)}`;
    }
  }
  if (!failure) return { outcome: 'updated', installedVersion, health };

  // 7. Rollback.
  logger.warn({ item: key, error: failure }, 'update failed; rolling back');
  const rb = await rollback(ctx, site, item, targets, archive, dbSnap, ops);
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
  site: SiteWithBypass,
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
  try {
    const health = await ctx.health.quick(site, c, ctx.opts.baseline);
    ops.push(`rollback: health quick: ${health.ok ? 'ok' : 'FAILED'}`);
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
  } catch (e) {
    return { recovered: false, installedVersion, error: `health check error after rollback: ${msg(e)}` };
  }
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

async function applyUpdate(remote: Remote, item: UpdateItem): Promise<void> {
  const v = `--version=${item.newVersion}`;
  if (remote.wpCli) {
    if (item.type === 'core') {
      await remote.wp(['core', 'update', v], 'wp core update');
      await remote.wp(['core', 'update-db'], 'wp core update-db');
    } else await remote.wp([item.type, 'update', item.slug, v], `wp ${item.type} update`);
    return;
  }
  await remote.c.call('wp.upgrade', { type: item.type, slug: item.slug, version: item.newVersion });
}

function describeUpdate(remote: Remote, item: UpdateItem): string[] {
  const v = `--version=${item.newVersion}`;
  if (remote.wpCli)
    return item.type === 'core'
      ? [`wp core update ${v}`, 'wp core update-db']
      : [`wp ${item.type} update ${item.slug} ${v}`];
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

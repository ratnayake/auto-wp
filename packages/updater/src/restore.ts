import { posix } from 'node:path';
import {
  type ApprovalResult,
  BACKUP_DIR_NAME,
  type BackupManifest,
  BackupManifestSchema,
  type Capabilities,
  type Check,
  type Clock,
  DB_ARTIFACT,
  FILES_ARTIFACT,
  type Logger,
  MANIFEST_FILE,
  type RestorePlan,
  type RestoreService,
  type SiteConfig,
  type SiteConnection,
  type VerificationResult,
} from '@auto-wp/contracts';
import { canonicalJson, sha256Hex } from './canonical-json.js';
import { agentLocation, assertSafeId, backupRootCandidates } from './paths.js';
import { Remote } from './remote.js';
import { msg } from './util.js';

export class RestoreRefusedError extends Error {
  override name = 'RestoreRefusedError';
}

export interface DefaultRestoreDeps {
  logger: Logger;
  clock: Clock;
}

interface Loaded {
  dir: string;
  manifest: BackupManifest;
}

const wantsDb = (s: RestorePlan['scope']) => s !== 'files';
const wantsFiles = (s: RestorePlan['scope']) => s !== 'db';

export class DefaultRestoreService implements RestoreService {
  constructor(private readonly deps: DefaultRestoreDeps) {}

  async plan(
    site: SiteConfig,
    c: SiteConnection,
    backupId: string,
    scope: RestorePlan['scope'],
  ): Promise<RestorePlan> {
    assertSafeId('backupId', backupId);
    const caps = await c.probe();
    const loaded = await loadManifest(site, c, caps, backupId);
    const steps = buildSteps(site, loaded, scope);
    return {
      planHash: planHash(site.id, backupId, scope, steps, loaded.manifest),
      siteId: site.id,
      backupId,
      scope,
      steps,
      createdAt: this.deps.clock.now().toISOString(),
    };
  }

  async execute(
    site: SiteConfig,
    c: SiteConnection,
    plan: RestorePlan,
    approval: ApprovalResult,
  ): Promise<VerificationResult> {
    const { logger, clock } = this.deps;
    // --- refusals: nothing has been touched yet -------------------------------------------------
    if (!approval.approved) throw new RestoreRefusedError('restore not approved');
    if (approval.planHash !== plan.planHash)
      throw new RestoreRefusedError('approval was given for a different plan hash');
    if (plan.siteId !== site.id)
      throw new RestoreRefusedError(`plan is for site ${plan.siteId}, not ${site.id}`);
    assertSafeId('backupId', plan.backupId);

    const caps = await c.probe();
    const remote = new Remote(c, caps);
    const loaded = await loadManifest(site, c, caps, plan.backupId);
    const steps = buildSteps(site, loaded, plan.scope);
    if (planHash(site.id, plan.backupId, plan.scope, steps, loaded.manifest) !== plan.planHash)
      throw new RestoreRefusedError(
        'plan does not match the current backup manifest; re-plan and re-approve',
      );

    const checks: Check[] = [];
    for (const name of requiredArtifacts(plan.scope)) {
      const art = loaded.manifest.artifacts.find((a) => a.name === name);
      if (!art) throw new RestoreRefusedError(`artifact ${name} missing from manifest`);
      const actual = await remote.sha256(`${loaded.dir}/${name}`);
      if (actual !== art.sha256)
        throw new RestoreRefusedError(
          `artifact ${name} sha256 mismatch: manifest ${art.sha256}, actual ${actual}`,
        );
    }
    checks.push({ name: 'artifacts.sha256', ok: true, severity: 'info' });

    const lockId = `restore-${plan.backupId}`;
    const lock = await c.call('lock.acquire', { runId: lockId, ttlSec: 7200 });
    if (!lock.acquired) throw new Error(`site is locked by ${lock.holder ?? 'another run'}`);

    logger.warn({ siteId: site.id, backupId: plan.backupId, scope: plan.scope }, 'restore starting');
    let step = 'maintenance on';
    const ts = clock.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const aside = `${loaded.dir}/pre-restore-${ts}`;
    const preDump = `${aside}.sql.gz`;
    let dbReplaced = false;
    let failed: string | undefined;
    try {
      try {
        await c.call('wp.maintenance', { enabled: true });
        if (wantsDb(plan.scope)) {
          // Keep the current DB so a failed restore can be undone. No dump, no import.
          step = 'db dump current';
          await c.call('db.dump', { dest: preDump, excludeTables: [] });
          step = 'db import';
          dbReplaced = true;
          await c.call('db.import', { source: `${loaded.dir}/${DB_ARTIFACT}` });
        }
        if (wantsFiles(plan.scope)) {
          step = 'files';
          const carryFailures = await swapFiles(c, remote, site, loaded, aside, (s) => {
            step = s;
          });
          checks.push({ name: 'files.swap', ok: true, severity: 'info', details: { preRestoreDir: aside } });
          if (carryFailures.length)
            checks.push({
              name: 'files.carryOver',
              ok: false,
              severity: 'error',
              details: {
                message: 'excluded paths could not be moved back from the pre-restore tree',
                carryFailures,
              },
            });
        }
        step = 'cache flush';
        await c.call('cache.flush', { opcache: true, objectCache: true }).catch((e: unknown) => {
          logger.warn({ siteId: site.id, error: msg(e) }, 'cache flush failed after restore');
        });
      } catch (e) {
        failed = `${step}: ${msg(e)}`;
        logger.error({ siteId: site.id, backupId: plan.backupId, error: failed }, 'RESTORE FAILED');
        checks.push({
          name: 'restore.execute',
          ok: false,
          severity: 'error',
          details: { step, error: msg(e), preRestoreDir: wantsFiles(plan.scope) ? aside : undefined },
        });
        if (dbReplaced) checks.push(await revertDb(c, preDump, logger));
      } finally {
        try {
          await c.call('wp.maintenance', { enabled: false });
          checks.push({ name: 'maintenance.off', ok: true, severity: 'info' });
        } catch (e) {
          logger.error(
            { siteId: site.id, error: msg(e) },
            'MAINTENANCE MODE COULD NOT BE DISABLED after restore: the site may still show the maintenance page',
          );
          checks.push({ name: 'maintenance.off', ok: false, severity: 'error', details: { error: msg(e) } });
        }
      }
      if (!failed && wantsDb(plan.scope)) checks.push(await verifyRowCounts(c, loaded.manifest));
    } finally {
      await c.call('lock.release', { runId: lockId }).catch((e: unknown) => {
        logger.error({ siteId: site.id, error: msg(e) }, 'failed to release site lock');
      });
    }

    const ok = checks.every((ch) => ch.ok || ch.severity !== 'error');
    logger.info({ siteId: site.id, backupId: plan.backupId, ok }, 'restore finished');
    return { backupId: plan.backupId, ok, verifiedAt: clock.now().toISOString(), checks };
  }
}

async function revertDb(c: SiteConnection, preDump: string, logger: Logger): Promise<Check> {
  try {
    await c.call('db.import', { source: preDump });
    return {
      name: 'db.revert',
      ok: true,
      severity: 'warn',
      details: { message: 'pre-restore DB re-imported' },
    };
  } catch (e) {
    logger.error({ error: msg(e), preDump }, 'could not re-import the pre-restore DB');
    return { name: 'db.revert', ok: false, severity: 'error', details: { error: msg(e), preDump } };
  }
}

/**
 * Extract to staging, move the live tree aside (except backups, the agent, the maintenance flag and
 * top-level paths the backup excluded), move staging into place, then move nested excluded paths (and a
 * wp-config.php the backup lacks) back from the aside tree. Either move phase is undone if it fails
 * part-way. Returns carry-over paths that could not be moved back.
 */
async function swapFiles(
  c: SiteConnection,
  remote: Remote,
  site: SiteConfig,
  { dir, manifest }: Loaded,
  aside: string,
  setStep: (s: string) => void,
): Promise<string[]> {
  const { keep, carry } = fileRules(site, manifest);
  const staging = `${dir}/restore-staging`;
  setStep('files extract to staging');
  if (await c.stat(staging)) await c.remove(staging, { recursive: true });
  await c.mkdir(staging, { recursive: true });
  await remote.extract(`${dir}/${FILES_ARTIFACT}`, staging);
  const staged = (await c.list(staging)).map((e) => posix.basename(e.path)).filter((n) => !keep.has(n));
  if (staged.length === 0) throw new Error('extracted backup is empty; live files left untouched');

  setStep('files move current tree aside');
  await c.mkdir(aside, { recursive: true });
  const live = (await c.list('.')).map((e) => posix.basename(e.path)).filter((n) => !keep.has(n));
  const movedOut: string[] = [];
  const movedIn: string[] = [];
  const undo = async () => {
    for (const n of movedIn.reverse()) await c.rename(n, `${staging}/${n}`).catch(() => undefined);
    for (const n of movedOut.reverse()) await c.rename(`${aside}/${n}`, n).catch(() => undefined);
  };
  try {
    for (const n of live) {
      await c.rename(n, `${aside}/${n}`);
      movedOut.push(n);
    }
    setStep('files move staging into place');
    for (const n of staged) {
      await c.rename(`${staging}/${n}`, n);
      movedIn.push(n);
    }
  } catch (e) {
    await undo();
    throw e;
  }

  setStep('files carry over excluded paths');
  const failures: string[] = [];
  for (const p of carry) {
    try {
      if ((await c.stat(p)) || !(await c.stat(`${aside}/${p}`))) continue;
      const parent = posix.dirname(p);
      if (parent !== '.') await c.mkdir(parent, { recursive: true });
      await c.rename(`${aside}/${p}`, p);
    } catch {
      failures.push(p);
    }
  }
  return failures;
}

/**
 * keep: top-level names never moved. carry: nested paths restored from the live tree when the backup
 * does not contain them. Glob excludes cannot be carried over and are only reported in the plan.
 */
function fileRules(
  site: SiteConfig,
  manifest: BackupManifest,
): { keep: Set<string>; carry: string[]; globs: string[] } {
  const keep = new Set([BACKUP_DIR_NAME, '.maintenance']);
  const agent = agentLocation(site).topLevel;
  if (agent) keep.add(agent);
  const carry = new Set(['wp-config.php']);
  const globs: string[] = [];
  for (const raw of manifest.files.excludes) {
    const p = posix.normalize(raw.replace(/^\.?\/+/, '')).replace(/\/+$/, '');
    if (/[*?[\]]/.test(p)) globs.push(raw);
    else if (!p || p === '.' || p.startsWith('..')) continue;
    else if (!p.includes('/')) keep.add(p);
    else carry.add(p);
  }
  return { keep, carry: [...carry].sort(), globs };
}

function requiredArtifacts(scope: RestorePlan['scope']): string[] {
  return [...(wantsDb(scope) ? [DB_ARTIFACT] : []), ...(wantsFiles(scope) ? [FILES_ARTIFACT] : [])];
}

async function loadManifest(
  site: SiteConfig,
  c: SiteConnection,
  caps: Capabilities,
  backupId: string,
): Promise<Loaded> {
  for (const root of backupRootCandidates(site, caps)) {
    const dir = `${root}/${backupId}`;
    const path = `${dir}/${MANIFEST_FILE}`;
    if ((await c.stat(path))?.type !== 'file') continue;
    const manifest = BackupManifestSchema.parse(JSON.parse((await c.readFile(path)).toString('utf8')));
    if (manifest.backupId !== backupId)
      throw new RestoreRefusedError(`manifest backupId mismatch in ${path}`);
    if (manifest.siteId !== site.id)
      throw new RestoreRefusedError(`backup ${backupId} belongs to another site`);
    return { dir, manifest };
  }
  throw new RestoreRefusedError(`backup ${backupId} not found`);
}

function buildSteps(site: SiteConfig, { dir, manifest }: Loaded, scope: RestorePlan['scope']): string[] {
  for (const name of requiredArtifacts(scope)) {
    const art = manifest.artifacts.find((a) => a.name === name);
    if (!art) throw new RestoreRefusedError(`backup has no ${name} artifact; cannot restore scope ${scope}`);
    if (art.encrypted)
      throw new RestoreRefusedError(`artifact ${name} is encrypted; decrypt it before restoring`);
  }
  const steps = ['maintenance on'];
  if (wantsDb(scope))
    steps.push(`db dump current -> ${dir}/pre-restore-<timestamp>.sql.gz`, `db import ${dir}/${DB_ARTIFACT}`);
  if (wantsFiles(scope)) {
    const nested = agentLocation(site).nested;
    if (nested)
      throw new RestoreRefusedError(
        `the agent is installed at ${nested}; a file restore would move it away mid-restore`,
      );
    const { keep, carry, globs } = fileRules(site, manifest);
    steps.push(
      `files extract ${dir}/${FILES_ARTIFACT} -> ${dir}/restore-staging`,
      `files move current tree -> ${dir}/pre-restore-<timestamp> (keeping ${[...keep].sort().join(', ')})`,
      `files move ${dir}/restore-staging/* -> site root`,
      `files carry over from current tree if absent in backup: ${carry.join(', ')}`,
    );
    if (globs.length) steps.push(`files NOT carried over (pattern excludes): ${globs.join(', ')}`);
  }
  steps.push('cache flush', 'maintenance off');
  if (wantsDb(scope)) steps.push('verify db row counts against manifest');
  return steps;
}

function planHash(
  siteId: string,
  backupId: string,
  scope: RestorePlan['scope'],
  steps: string[],
  manifest: BackupManifest,
): string {
  const sha256s = manifest.artifacts.map((a) => ({ name: a.name, sha256: a.sha256 }));
  return sha256Hex(canonicalJson({ siteId, backupId, scope, steps, sha256s }));
}

async function verifyRowCounts(c: SiteConnection, manifest: BackupManifest): Promise<Check> {
  try {
    const info = await c.call('db.info', {});
    const actual = new Map(info.tables.map((t) => [t.name, t.rows]));
    const mismatches = manifest.db.tables
      .filter((t) => actual.get(t.name) !== t.rows)
      .map((t) => ({ table: t.name, expected: t.rows, actual: actual.get(t.name) ?? null }));
    return {
      name: 'db.rowCounts',
      ok: mismatches.length === 0,
      severity: mismatches.length ? 'error' : 'info',
      details: { tables: manifest.db.tables.length, mismatches },
    };
  } catch (e) {
    return { name: 'db.rowCounts', ok: false, severity: 'error', details: { error: msg(e) } };
  }
}

import { posix } from 'node:path';
import {
  type ApprovalResult,
  BACKUP_DIR_NAME,
  type BackupManifest,
  BackupManifestSchema,
  type Capabilities,
  type Check,
  type Clock,
  type Logger,
  type RestorePlan,
  type RestoreService,
  type SiteConfig,
  type SiteConnection,
  type VerificationResult,
} from '@auto-wp/contracts';
import { canonicalJson, sha256Hex } from './canonical-json.js';
import { agentDirName, assertSafeId, backupRootCandidates } from './paths.js';
import { Remote } from './remote.js';

export const MANIFEST_FILE = 'manifest.json';
export const DB_ARTIFACT = 'db.sql.gz';
export const FILES_ARTIFACT = 'files.tar.gz';

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

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
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
    let failed: string | undefined;
    try {
      try {
        await c.call('wp.maintenance', { enabled: true });
        if (wantsDb(plan.scope)) {
          step = 'db import';
          await c.call('db.import', { source: `${loaded.dir}/${DB_ARTIFACT}` });
        }
        if (wantsFiles(plan.scope)) {
          step = 'files';
          await swapFiles(c, remote, site, loaded.dir, aside, (s) => {
            step = s;
          });
          checks.push({ name: 'files.swap', ok: true, severity: 'info', details: { preRestoreDir: aside } });
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

/**
 * Extract to staging, move the live tree aside (except backups, the agent and the maintenance flag),
 * then move staging into place. If moving aside fails part-way, already-moved entries are put back.
 */
async function swapFiles(
  c: SiteConnection,
  remote: Remote,
  site: SiteConfig,
  dir: string,
  aside: string,
  setStep: (s: string) => void,
): Promise<void> {
  const keep = keepInPlace(site);
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
  const moved: string[] = [];
  try {
    for (const n of live) {
      await c.rename(n, `${aside}/${n}`);
      moved.push(n);
    }
  } catch (e) {
    for (const n of moved.reverse()) await c.rename(`${aside}/${n}`, n).catch(() => undefined);
    throw e;
  }

  setStep('files move staging into place');
  for (const n of staged) await c.rename(`${staging}/${n}`, n);
}

function keepInPlace(site: SiteConfig): Set<string> {
  const keep = new Set([BACKUP_DIR_NAME, '.maintenance']);
  const agent = agentDirName(site);
  if (agent) keep.add(agent);
  return keep;
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
  const keep = [...keepInPlace(site)].sort().join(', ');
  const steps = ['maintenance on'];
  if (wantsDb(scope)) steps.push(`db import ${dir}/${DB_ARTIFACT}`);
  if (wantsFiles(scope))
    steps.push(
      `files extract ${dir}/${FILES_ARTIFACT} -> ${dir}/restore-staging`,
      `files move current tree -> ${dir}/pre-restore-<timestamp> (keeping ${keep})`,
      `files move ${dir}/restore-staging/* -> site root`,
    );
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

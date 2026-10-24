import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  BACKUP_DIR_NAME,
  type BackupManifest,
  BackupManifestSchema,
  type BackupVerifier,
  type Check,
  type Clock,
  type Logger,
  type SiteConfig,
  type SiteConnection,
  type VerificationResult,
} from '@auto-wp/contracts';
import { deepRestore } from './deep.js';
import type { DockerRunner } from './docker.js';
import { type SqlScanResult, scanGzipSqlStream } from './sql-scanner.js';
import { walkTarGz } from './tar.js';
import {
  DEFAULT_FILE_TOLERANCE,
  DEFAULT_VOLATILE_ROW_TOLERANCE,
  errMsg,
  isVolatileTable,
  sha256Stream,
  type Tolerance,
  withinTolerance,
} from './util.js';

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_SIG_NAME = 'manifest.json.sig';
export const DB_ARTIFACT = 'db.sql.gz';
export const FILES_ARTIFACT = 'files.tar.gz';

export interface ManifestSignatureVerifier {
  /** Resolve true when `signature` is a valid signature over the exact `manifest` bytes. */
  verify(manifest: Buffer, signature: Buffer): boolean | Promise<boolean>;
}

export interface BackupVerifierDeps {
  logger: Logger;
  clock: Clock;
  /** Pulled backups live in `<dataDir>/backups/<siteId>/<backupId>/`. */
  dataDir: string;
  signatureVerifier?: ManifestSignatureVerifier;
  /** Enables the `deep.restore` drill when `verify(..., {deep: true})`. */
  dockerRunner?: DockerRunner;
  dockerImage?: string;
  /** Live file-count drift allowed before warning. Default max(5, 0.5%). */
  fileTolerance?: Tolerance;
  /** Live row-count drift allowed for volatile tables. Default max(25, 20%). */
  volatileRowTolerance?: Tolerance;
  /** Extra table-name patterns treated as volatile (matched against the full table name). */
  volatileTablePatterns?: RegExp[];
  sleep?: (ms: number) => Promise<void>;
}

type Artifact = BackupManifest['artifacts'][number];
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const pass = (name: string, details?: unknown, severity: Check['severity'] = 'info'): Check => ({
  name,
  ok: true,
  severity,
  details,
});
const fail = (name: string, details?: unknown, severity: Check['severity'] = 'error'): Check => ({
  name,
  ok: false,
  severity,
  details,
});

interface ShaOutcome {
  ok: boolean;
  sha256?: string;
  bytes?: number;
  error?: string;
}

export class DefaultBackupVerifier implements BackupVerifier {
  private readonly fileTol: Tolerance;
  private readonly rowTol: Tolerance;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: BackupVerifierDeps) {
    this.fileTol = deps.fileTolerance ?? DEFAULT_FILE_TOLERANCE;
    this.rowTol = deps.volatileRowTolerance ?? DEFAULT_VOLATILE_ROW_TOLERANCE;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async verify(
    site: SiteConfig,
    c: SiteConnection,
    backupId: string,
    o: { deep?: boolean } = {},
  ): Promise<VerificationResult> {
    const checks: Check[] = [];
    const finish = (): VerificationResult => ({
      backupId,
      ok: !checks.some((k) => !k.ok && k.severity === 'error'),
      verifiedAt: this.deps.clock.now().toISOString(),
      checks,
    });

    if (!SAFE_ID.test(backupId) || backupId === '.' || backupId === '..') {
      checks.push(fail('manifest.schema', { error: 'invalid backup id' }));
      return finish();
    }
    const localDir = join(this.deps.dataDir, 'backups', site.id, backupId);
    const remoteDir = await this.locateRemote(site, c, backupId);

    // ---- manifest --------------------------------------------------------------------------
    let manifestBytes: Buffer | undefined;
    let localManifest: Buffer | undefined;
    try {
      localManifest = await readFile(join(localDir, MANIFEST_NAME));
    } catch {
      /* not pulled */
    }
    if (remoteDir) {
      try {
        manifestBytes = await c.readFile(posix.join(remoteDir, MANIFEST_NAME));
      } catch (e) {
        this.deps.logger.warn({ err: errMsg(e), backupId }, 'cannot read remote manifest');
      }
    }
    manifestBytes ??= localManifest;
    if (!manifestBytes) {
      checks.push(fail('manifest.schema', { error: 'manifest not found remotely or locally', remoteDir }));
      return finish();
    }
    let manifest: BackupManifest;
    try {
      manifest = BackupManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    } catch (e) {
      checks.push(fail('manifest.schema', { error: errMsg(e) }));
      return finish();
    }
    if (manifest.backupId !== backupId || manifest.siteId !== site.id) {
      checks.push(
        fail('manifest.schema', {
          error: 'manifest identity mismatch',
          manifest: { backupId: manifest.backupId, siteId: manifest.siteId },
          expected: { backupId, siteId: site.id },
        }),
      );
      return finish();
    }
    checks.push(pass('manifest.schema'));
    if (remoteDir && localManifest && !localManifest.equals(manifestBytes)) {
      checks.push(fail('manifest.local', { error: 'pulled manifest differs from remote manifest' }));
    }

    await this.safely(checks, 'manifest.signature', async () => {
      await this.checkSignature(checks, c, remoteDir, localDir, manifestBytes);
    });

    // ---- artifact checksums ----------------------------------------------------------------
    const localPresent = new Map<string, boolean>();
    for (const a of manifest.artifacts) {
      if (!SAFE_NAME.test(a.name) || a.name === '.' || a.name === '..') {
        checks.push(fail(`artifact.sha256:${a.name}`, { error: 'unsafe artifact name' }));
        continue;
      }
      localPresent.set(a.name, await exists(join(localDir, a.name)));
      await this.safely(checks, `artifact.sha256:${a.name}`, async () => {
        checks.push(await this.checkArtifact(c, remoteDir, localDir, a, localPresent.get(a.name) === true));
      });
    }

    const sources = {
      c,
      remoteDir,
      localDir,
      localPresent,
    };

    // ---- files archive ---------------------------------------------------------------------
    const filesArtifact = manifest.artifacts.find((a) => a.name === FILES_ARTIFACT);
    await this.safely(checks, 'archive.integrity', async () => {
      await this.checkFiles(checks, sources, manifest, filesArtifact);
    });

    // ---- database --------------------------------------------------------------------------
    const dbArtifact = manifest.artifacts.find((a) => a.name === DB_ARTIFACT);
    let scan: SqlScanResult | undefined;
    await this.safely(checks, 'db.terminator', async () => {
      scan = await this.checkDb(checks, c, sources, manifest, dbArtifact);
    });

    if (o.deep) {
      await this.safely(checks, 'deep.restore', async () => {
        checks.push(await this.checkDeep(localDir, sources, manifest, dbArtifact, scan));
      });
    }
    return finish();
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async safely(checks: Check[], name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.deps.logger.error({ err: errMsg(e), check: name }, 'verification step crashed');
      checks.push(fail(name, { error: errMsg(e) }));
    }
  }

  private async locateRemote(site: SiteConfig, c: SiteConnection, id: string): Promise<string | undefined> {
    let caps: Awaited<ReturnType<SiteConnection['probe']>>;
    try {
      caps = await c.probe();
    } catch (e) {
      this.deps.logger.warn({ err: errMsg(e) }, 'probe failed; cannot locate remote backup');
      return undefined;
    }
    const inDocroot = posix.join(caps.wpRoot, BACKUP_DIR_NAME, id);
    const outside = caps.outsideDocrootDir
      ? posix.join(caps.outsideDocrootDir, BACKUP_DIR_NAME, id)
      : undefined;
    const order = site.backupLocation === 'outside' ? [outside, inDocroot] : [inDocroot, outside];
    for (const dir of order) {
      if (!dir) continue;
      try {
        if (await c.stat(posix.join(dir, MANIFEST_NAME))) return dir;
      } catch {
        /* jail or transport error: try the next candidate */
      }
    }
    return undefined;
  }

  private async checkSignature(
    checks: Check[],
    c: SiteConnection,
    remoteDir: string | undefined,
    localDir: string,
    manifestBytes: Buffer,
  ): Promise<void> {
    let sig: Buffer | undefined;
    if (remoteDir) {
      try {
        if (await c.stat(posix.join(remoteDir, MANIFEST_SIG_NAME)))
          sig = await c.readFile(posix.join(remoteDir, MANIFEST_SIG_NAME));
      } catch {
        /* treated as absent */
      }
    }
    if (!sig) {
      try {
        sig = await readFile(join(localDir, MANIFEST_SIG_NAME));
      } catch {
        /* absent */
      }
    }
    const verifier = this.deps.signatureVerifier;
    if (!verifier) {
      if (sig) checks.push(pass('manifest.signature', { skipped: 'no signature verifier configured' }));
      return;
    }
    if (!sig) {
      checks.push(fail('manifest.signature', { error: 'manifest is not signed' }, 'warn'));
      return;
    }
    const valid = await verifier.verify(manifestBytes, sig);
    checks.push(
      valid ? pass('manifest.signature') : fail('manifest.signature', { error: 'signature invalid' }),
    );
  }

  private async remoteSha(c: SiteConnection, path: string): Promise<{ sha256: string; bytes: number }> {
    try {
      return await c.call('fs.sha256', { path });
    } catch (e) {
      this.deps.logger.debug({ err: errMsg(e) }, 'fs.sha256 unavailable, falling back to sha256sum');
    }
    const r = await c.exec(['sha256sum', '--', path]);
    const m = /^([0-9a-f]{64})\s/i.exec(r.stdout);
    if (r.exitCode !== 0 || !m?.[1]) throw new Error(`sha256sum failed: ${r.stderr.trim() || r.exitCode}`);
    const st = await c.stat(path);
    return { sha256: m[1].toLowerCase(), bytes: st?.size ?? -1 };
  }

  private async checkArtifact(
    c: SiteConnection,
    remoteDir: string | undefined,
    localDir: string,
    a: Artifact,
    localPresent: boolean,
  ): Promise<Check> {
    const name = `artifact.sha256:${a.name}`;
    let remote: ShaOutcome | 'unavailable' = 'unavailable';
    if (remoteDir) {
      try {
        const r = await this.remoteSha(c, posix.join(remoteDir, a.name));
        remote = {
          ok: r.sha256.toLowerCase() === a.sha256 && (r.bytes < 0 || r.bytes === a.bytes),
          sha256: r.sha256,
          bytes: r.bytes,
        };
      } catch (e) {
        remote = { ok: false, error: errMsg(e) };
      }
    }
    let local: ShaOutcome | 'absent' = 'absent';
    if (localPresent) {
      try {
        const r = await sha256Stream(createReadStream(join(localDir, a.name)));
        local = { ok: r.sha256 === a.sha256 && r.bytes === a.bytes, sha256: r.sha256, bytes: r.bytes };
      } catch (e) {
        local = { ok: false, error: errMsg(e) };
      }
    }
    const details = { expected: { sha256: a.sha256, bytes: a.bytes }, remote, local };
    const remoteOk = remote === 'unavailable' || remote.ok;
    const localOk = local === 'absent' || local.ok;
    if (remote === 'unavailable' && local === 'absent') {
      return fail(name, { ...details, error: 'artifact not found remotely or locally' });
    }
    return remoteOk && localOk ? pass(name, details) : fail(name, details);
  }

  private async checkFiles(
    checks: Check[],
    s: Sources,
    manifest: BackupManifest,
    artifact: Artifact | undefined,
  ): Promise<void> {
    if (!artifact) {
      checks.push(fail('archive.integrity', { error: `manifest has no ${FILES_ARTIFACT} artifact` }));
      return;
    }
    if (artifact.encrypted) {
      checks.push(pass('archive.integrity', { skipped: 'artifact is encrypted' }));
      return;
    }
    const remotePath = s.remoteDir ? posix.join(s.remoteDir, artifact.name) : undefined;
    const localPath = join(s.localDir, artifact.name);

    const details: { remote?: unknown; local?: unknown } = {};
    let ok = true;
    let attempted = false;
    if (remotePath) {
      attempted = true;
      try {
        const r = await this.remoteTestArchive(s.c, remotePath);
        details.remote = r;
        ok &&= r.ok;
      } catch (e) {
        details.remote = { ok: false, error: errMsg(e) };
        ok = false;
      }
    }
    let localFiles: number | undefined;
    if (s.localPresent.get(artifact.name)) {
      attempted = true;
      try {
        const r = await walkTarGz(createReadStream(localPath));
        details.local = { ok: true, ...r };
        localFiles = r.files;
      } catch (e) {
        details.local = { ok: false, error: errMsg(e) };
        ok = false;
      }
    }
    if (!attempted) {
      checks.push(fail('archive.integrity', { error: 'archive not found remotely or locally' }));
      return;
    }
    checks.push(ok ? pass('archive.integrity', details) : fail('archive.integrity', details));

    // files.count: archive vs manifest (exact), then manifest vs live (tolerant, warn only).
    if (localFiles === undefined) {
      checks.push(
        details.local
          ? fail('files.count', { error: 'archive unreadable', expected: manifest.files.count })
          : pass('files.count', { skipped: 'no local copy of the archive', expected: manifest.files.count }),
      );
    } else {
      const match = localFiles === manifest.files.count;
      checks.push(
        (match ? pass : fail)('files.count', { archive: localFiles, manifest: manifest.files.count }),
      );
    }
    await this.safely(checks, 'files.count.live', async () => {
      const caps = await s.c.probe();
      const live = await s.c.call('fs.count', { dir: caps.wpRoot, excludes: manifest.files.excludes });
      const within = withinTolerance(manifest.files.count, live.fileCount, this.fileTol);
      checks.push(
        within
          ? pass('files.count.live', {
              live: live.fileCount,
              manifest: manifest.files.count,
              tolerance: this.fileTol,
            })
          : fail(
              'files.count.live',
              { live: live.fileCount, manifest: manifest.files.count, tolerance: this.fileTol },
              'warn',
            ),
      );
    });
  }

  private async remoteTestArchive(
    c: SiteConnection,
    path: string,
  ): Promise<{ ok: boolean; entries?: number; error?: string }> {
    try {
      return await c.call('fs.testArchive', { path });
    } catch (e) {
      this.deps.logger.debug({ err: errMsg(e) }, 'fs.testArchive unavailable, falling back to gzip/tar');
    }
    const gz = await c.exec(['gzip', '-t', path]);
    if (gz.exitCode !== 0) return { ok: false, error: `gzip -t: ${gz.stderr.trim() || gz.exitCode}` };
    const tar = await c.exec(['tar', '-tzf', path]);
    if (tar.exitCode !== 0) return { ok: false, error: `tar -tzf: ${tar.stderr.trim() || tar.exitCode}` };
    const entries = tar.stdout.split('\n').filter((l) => l.length > 0).length;
    return { ok: true, entries };
  }

  private async openDump(s: Sources): Promise<Readable> {
    if (s.localPresent.get(DB_ARTIFACT)) return createReadStream(join(s.localDir, DB_ARTIFACT));
    if (!s.remoteDir) throw new Error('database dump not found remotely or locally');
    return (await s.c.download(posix.join(s.remoteDir, DB_ARTIFACT))) as Readable;
  }

  private async checkDb(
    checks: Check[],
    c: SiteConnection,
    s: Sources,
    manifest: BackupManifest,
    artifact: Artifact | undefined,
  ): Promise<SqlScanResult | undefined> {
    if (!artifact) {
      checks.push(fail('db.terminator', { error: `manifest has no ${DB_ARTIFACT} artifact` }));
      return undefined;
    }
    if (artifact.encrypted) {
      checks.push(pass('db.terminator', { skipped: 'artifact is encrypted' }));
      return undefined;
    }
    let scan: SqlScanResult;
    try {
      scan = await scanGzipSqlStream(await this.openDump(s));
    } catch (e) {
      checks.push(fail('db.terminator', { error: `dump unreadable: ${errMsg(e)}` }));
      return undefined;
    }
    checks.push(
      scan.terminator && !scan.truncated
        ? pass('db.terminator', { bytes: scan.bytes })
        : fail('db.terminator', {
            error: scan.truncated ? 'dump is truncated' : 'dump does not end with "-- Dump completed"',
            bytes: scan.bytes,
          }),
    );

    let live: { tables: { name: string; rows: number }[] } | undefined;
    try {
      live = await c.call('db.info', {});
    } catch (e) {
      this.deps.logger.warn({ err: errMsg(e) }, 'db.info unavailable; skipping live comparisons');
    }

    // db.tables
    const manifestNames = manifest.db.tables.map((t) => t.name);
    const missingFromDump = manifestNames.filter((n) => !scan.createTables.includes(n));
    const notInManifest = scan.createTables.filter((n) => !manifestNames.includes(n));
    const tableDetails: Record<string, unknown> = {
      dump: scan.createTables.length,
      manifest: manifestNames.length,
    };
    if (missingFromDump.length) tableDetails.missingFromDump = missingFromDump;
    if (notInManifest.length) tableDetails.notInManifest = notInManifest;
    checks.push(
      missingFromDump.length || notInManifest.length
        ? fail('db.tables', tableDetails)
        : pass('db.tables', tableDetails),
    );
    if (live) {
      const liveNames = live.tables.map((t) => t.name);
      const gone = manifestNames.filter((n) => !liveNames.includes(n));
      const added = liveNames.filter((n) => !manifestNames.includes(n));
      checks.push(
        gone.length || added.length
          ? fail('db.tables.live', { removedSinceBackup: gone, addedSinceBackup: added }, 'warn')
          : pass('db.tables.live'),
      );
    }

    // db.rows:<table>
    const liveRows = new Map(live?.tables.map((t) => [t.name, t.rows]));
    for (const t of manifest.db.tables) {
      const dumped = scan.rowsPerTable.get(t.name) ?? 0;
      const name = `db.rows:${t.name}`;
      if (isVolatileTable(t.name, this.deps.volatileTablePatterns)) {
        const reference = liveRows.get(t.name) ?? t.rows;
        const details = {
          dump: dumped,
          reference,
          referenceSource: liveRows.has(t.name) ? 'live' : 'manifest',
          volatile: true,
        };
        checks.push(
          withinTolerance(reference, dumped, this.rowTol) ? pass(name, details) : fail(name, details, 'warn'),
        );
      } else {
        const details = { dump: dumped, manifest: t.rows };
        checks.push(dumped === t.rows ? pass(name, details) : fail(name, details));
      }
    }
    return scan;
  }

  private async checkDeep(
    localDir: string,
    s: Sources,
    manifest: BackupManifest,
    artifact: Artifact | undefined,
    scan: SqlScanResult | undefined,
  ): Promise<Check> {
    const runner = this.deps.dockerRunner;
    if (!runner) return pass('deep.restore', { skipped: 'no docker runner configured' });
    if (!artifact || artifact.encrypted)
      return pass('deep.restore', { skipped: 'no readable database dump' });
    if (scan && (!scan.terminator || scan.truncated)) {
      return fail('deep.restore', { error: 'skipped: dump is incomplete' });
    }
    const outcome = await deepRestore({
      runner,
      image: this.deps.dockerImage ?? 'mariadb:10.11',
      tables: manifest.db.tables.map((t) => t.name),
      logger: this.deps.logger,
      sleep: this.sleep,
      openDump: () => {
        const src = s.localPresent.get(DB_ARTIFACT)
          ? createReadStream(join(localDir, DB_ARTIFACT))
          : undefined;
        if (!src) throw new Error('deep restore needs the pulled local dump');
        const gunzip = createGunzip();
        src.on('error', (e) => gunzip.destroy(e));
        return src.pipe(gunzip);
      },
    });
    if (!outcome.ok) return fail('deep.restore', { stage: outcome.stage, error: outcome.error });
    const mismatches: { table: string; restored: number | undefined; manifest: number; volatile: boolean }[] =
      [];
    for (const t of manifest.db.tables) {
      const restored = outcome.counts.get(t.name);
      const volatile = isVolatileTable(t.name, this.deps.volatileTablePatterns);
      const good = volatile
        ? restored !== undefined && withinTolerance(t.rows, restored, this.rowTol)
        : restored === t.rows;
      if (!good) mismatches.push({ table: t.name, restored, manifest: t.rows, volatile });
    }
    const hard = mismatches.filter((m) => !m.volatile);
    const details = { tables: manifest.db.tables.length, mismatches };
    if (hard.length) return fail('deep.restore', details);
    return mismatches.length
      ? { name: 'deep.restore', ok: false, severity: 'warn', details }
      : pass('deep.restore', details);
  }
}

interface Sources {
  c: SiteConnection;
  remoteDir: string | undefined;
  localDir: string;
  localPresent: Map<string, boolean>;
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

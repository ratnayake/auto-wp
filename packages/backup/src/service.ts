import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import {
  BACKUP_DIR_NAME,
  type BackupCreateOptions,
  type BackupManifest,
  BackupManifestSchema,
  type BackupService,
  type Capabilities,
  type Clock,
  type Logger,
  PolicySchema,
  type SiteConfig,
  type SiteConnection,
  TOOL_VERSION,
} from '@auto-wp/contracts';
import {
  BACKUP_EXCLUDES,
  BACKUP_ID_RE,
  DB_FILE,
  DISK_SAFETY_FACTOR,
  EST_BYTES_PER_ROW,
  FILES_FILE,
  HTACCESS,
  INDEX_PHP,
  MANIFEST_FILE,
  MYSQLDUMP_SCRIPT,
  SIG_FILE,
  WEB_CONFIG,
  WPCLI_DUMP_SCRIPT,
} from './constants.js';
import { BackupError, DiskSpaceError, ExposureError, LockError } from './errors.js';
import { listLocalIds, localSiteDir, pullBackup, removeLocal, selectPrune } from './local.js';

type DbMethod = BackupManifest['method']['db'];
type Location = 'docroot' | 'outside';

export interface DbCredentials {
  host: string;
  port?: number;
  user: string;
  password: string;
  name: string;
}
/** Supplies DB credentials (from the agent) for the mysqldump strategy; undefined means unavailable. */
export type DbCredentialsProvider = (conn: SiteConnection) => Promise<DbCredentials | undefined>;
export type RcloneRunner = (args: readonly string[]) => Promise<void>;

export interface BackupServiceDeps {
  logger: Logger;
  clock: Clock;
  fetch: typeof fetch;
  dataDir: string;
  /** Signs the exact bytes of manifest.json; the signature is stored base64 in manifest.json.sig. */
  signManifest?: (bytes: Buffer) => Promise<Buffer>;
  rclone?: RcloneRunner;
  randomHex?: (bytes: number) => string;
  dbCredentials?: DbCredentialsProvider;
}

/** What `create({dryRun: true})` returns: a manifest-shaped preview, nothing was written. */
export interface BackupPreview extends BackupManifest {
  dryRun: true;
  operations: string[];
  disk: { neededBytes: number; freeBytes?: number; ok: boolean };
  prune: { remote: string[]; local: string[] };
}
export const isBackupPreview = (m: BackupManifest): m is BackupPreview =>
  (m as BackupPreview).dryRun === true;

const defaultRclone: RcloneRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('rclone', [...args], { timeout: 6 * 3600_000 }, (err) =>
      err ? reject(new BackupError(`rclone failed: ${err.message}`)) : resolve(),
    );
  });

const compactIso = (d: Date): string =>
  d
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
const trunc = (s: string): string => (s.length > 500 ? `${s.slice(0, 500)}...` : s);
const optQuote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class DefaultBackupService implements BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  // ---- create ----------------------------------------------------------------------------------

  async create(site: SiteConfig, conn: SiteConnection, o: BackupCreateOptions = {}): Promise<BackupManifest> {
    const say = (m: string) => {
      this.deps.logger.info({ siteId: site.id }, m);
      o.onProgress?.(m);
    };
    const caps = await conn.probe();
    const id = this.newId();
    const excludes = [...BACKUP_EXCLUDES];
    const pull = o.pull ?? true;
    const retention = this.retention(site);

    say('estimating backup size');
    const count = await conn.call('fs.count', { dir: caps.wpRoot, excludes });
    const info = await conn.call('db.info', {});
    const dbRows = info.tables.reduce((n, t) => n + t.rows, 0);
    const neededBytes = Math.ceil((count.bytes + dbRows * EST_BYTES_PER_ROW) * DISK_SAFETY_FACTOR);
    const free = caps.diskFreeBytes;
    const diskOk = free === undefined || free >= neededBytes;
    if (free === undefined)
      this.deps.logger.warn({ siteId: site.id }, 'free disk space unknown; not checked');

    const location = this.initialLocation(site, caps);
    if (o.dryRun) {
      return this.preview(site, conn, caps, id, location, {
        info,
        count,
        excludes,
        pull,
        retention,
        disk: { neededBytes, freeBytes: free, ok: diskOk },
      });
    }
    if (!diskOk) {
      throw new DiskSpaceError(
        `not enough free disk space on the server: need about ${neededBytes} bytes (1.2x estimate), ${free} free. Backup aborted.`,
      );
    }

    say('acquiring remote lock');
    const lock = await conn.call('lock.acquire', { runId: id });
    if (!lock.acquired) {
      throw new LockError(`another operation holds the remote lock (${lock.holder ?? 'unknown holder'})`);
    }
    try {
      const { manifest, dir } = await this.runWithProtection(site, conn, caps, id, location, {
        info,
        count,
        excludes,
        say,
      });
      if (pull) {
        say('pulling artifacts');
        const localDir = await pullBackup(conn, this.deps.dataDir, dir, manifest);
        const remote = site.offsite.rcloneRemote;
        if (remote) {
          say('copying off-site with rclone');
          const target = `${remote.replace(/\/+$/, '')}/${site.id}/${id}`;
          try {
            await (this.deps.rclone ?? defaultRclone)(['copy', localDir, target]);
          } catch (e) {
            throw new BackupError(
              `backup ${id} was created and pulled, but the off-site rclone copy failed: ${(e as Error).message}`,
            );
          }
        }
      }
      say('applying retention');
      await this.applyRetention(site, conn, caps, id, retention);
      return manifest;
    } finally {
      try {
        await conn.call('lock.release', { runId: id });
      } catch (e) {
        this.deps.logger.warn(
          { siteId: site.id, err: (e as Error).message },
          'failed to release remote lock',
        );
      }
    }
  }

  private newId(): string {
    const hex = (this.deps.randomHex ?? ((n) => randomBytes(n).toString('hex')))(3);
    return `${compactIso(this.deps.clock.now())}-${hex}`;
  }

  private retention(site: SiteConfig): { remote: number; local: number } {
    return site.policy.retention ?? PolicySchema.parse({}).retention;
  }

  private initialLocation(site: SiteConfig, caps: Capabilities): Location {
    if (site.backupLocation === 'outside') {
      if (!caps.outsideDocrootDir) {
        throw new BackupError(
          'backupLocation is "outside" but the server has no writable directory above the docroot',
        );
      }
      return 'outside';
    }
    return 'docroot';
  }

  private baseDir(caps: Capabilities, loc: Location): string {
    const root = loc === 'outside' ? caps.outsideDocrootDir : caps.wpRoot;
    if (!root) throw new BackupError('no writable directory above the docroot');
    return posix.join(root, BACKUP_DIR_NAME);
  }

  private async runWithProtection(
    site: SiteConfig,
    conn: SiteConnection,
    caps: Capabilities,
    id: string,
    first: Location,
    ctx: RunCtx,
  ): Promise<{ manifest: BackupManifest; dir: string }> {
    let loc = first;
    for (;;) {
      const dir = posix.join(this.baseDir(caps, loc), id);
      let manifest: BackupManifest;
      try {
        manifest = await this.build(site, conn, caps, id, dir, ctx);
        if (loc === 'outside') return { manifest, dir };
        const exposed = await this.exposedUrls(site, id);
        if (exposed.length === 0) return { manifest, dir };
        this.deps.logger.warn({ siteId: site.id, exposed }, 'backup folder is publicly readable');
        await this.cleanup(conn, dir);
        if (!caps.outsideDocrootDir) {
          throw new ExposureError(
            `backup files were publicly downloadable (HTTP 200: ${exposed.join(', ')}) and the server has no directory above the docroot to fall back to. The backup was deleted. Block ${BACKUP_DIR_NAME}/ in the web server config (e.g. nginx: location ^~ /${BACKUP_DIR_NAME}/ { deny all; }) and retry.`,
          );
        }
        ctx.say('docroot backup folder is exposed; retrying outside the docroot');
        loc = 'outside';
      } catch (e) {
        await this.cleanup(conn, dir);
        throw e;
      }
    }
  }

  private async cleanup(conn: SiteConnection, dir: string): Promise<void> {
    try {
      await conn.remove(dir, { recursive: true });
    } catch (e) {
      this.deps.logger.warn({ dir, err: (e as Error).message }, 'could not remove backup folder');
    }
  }

  private async build(
    site: SiteConfig,
    conn: SiteConnection,
    caps: Capabilities,
    id: string,
    dir: string,
    ctx: RunCtx,
  ): Promise<BackupManifest> {
    const base = posix.dirname(dir);
    await conn.mkdir(base, { recursive: true, mode: 0o755 });
    await conn.writeFile(posix.join(base, '.htaccess'), HTACCESS, { mode: 0o644 });
    await conn.writeFile(posix.join(base, 'index.php'), INDEX_PHP, { mode: 0o644 });
    await conn.writeFile(posix.join(base, 'web.config'), WEB_CONFIG, { mode: 0o644 });
    await conn.mkdir(dir, { recursive: true, mode: 0o700 });

    ctx.say('dumping database');
    const dbMethod = await this.dumpDb(conn, caps, dir, id);
    ctx.say('archiving files');
    const filesMethod = await this.archiveFiles(conn, caps, dir, ctx);

    ctx.say('hashing artifacts');
    const artifacts = [];
    for (const name of [DB_FILE, FILES_FILE]) {
      const h = await this.hash(conn, caps, posix.join(dir, name));
      if (h.bytes === 0) throw new BackupError(`${name} is empty`);
      artifacts.push({ name, bytes: h.bytes, sha256: h.sha256 });
    }

    const manifest = BackupManifestSchema.parse({
      schemaVersion: 1,
      backupId: id,
      siteId: site.id,
      createdAt: this.deps.clock.now().toISOString(),
      toolVersion: TOOL_VERSION,
      location: dir,
      wp: {
        core: await this.coreVersion(conn, caps),
        php: caps.phpVersion,
        db: `${ctx.info.server} ${ctx.info.version}`,
      },
      method: { db: dbMethod, files: filesMethod.method },
      db: { tables: ctx.info.tables, charset: ctx.info.charset },
      files: { count: filesMethod.count, bytes: filesMethod.bytes, excludes: ctx.excludes },
      artifacts,
    });
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await conn.writeFile(posix.join(dir, MANIFEST_FILE), bytes, { mode: 0o600 });
    if (this.deps.signManifest) {
      const sig = await this.deps.signManifest(bytes);
      await conn.writeFile(posix.join(dir, SIG_FILE), sig.toString('base64'), { mode: 0o600 });
    }
    return manifest;
  }

  // ---- database --------------------------------------------------------------------------------

  private async dumpDb(conn: SiteConnection, caps: Capabilities, dir: string, id: string): Promise<DbMethod> {
    const dest = posix.join(dir, DB_FILE);
    const iso = this.deps.clock.now().toISOString();
    const strategies: Array<{ name: string; run: () => Promise<DbMethod> }> = [];
    if (caps.shell && caps.wpCli.available) {
      strategies.push({
        name: 'wp-cli',
        run: async () => {
          await this.sh(conn, [
            'bash',
            '-c',
            WPCLI_DUMP_SCRIPT,
            'auto-wp-dump',
            caps.wpCli.path ?? 'wp',
            caps.wpRoot,
            dest,
            iso,
          ]);
          return 'wpcli';
        },
      });
    }
    const mysqldump = caps.binaries.mysqldump;
    if (caps.shell && mysqldump && this.deps.dbCredentials) {
      strategies.push({
        name: 'mysqldump',
        run: async () => {
          const creds = await this.deps.dbCredentials?.(conn);
          if (!creds) throw new BackupError('database credentials unavailable');
          const cnf = posix.join(caps.outsideDocrootDir ?? dir, `.auto-wp-${id}.cnf`);
          const lines = ['[client]', `user=${optQuote(creds.user)}`, `password=${optQuote(creds.password)}`];
          lines.push(`host=${optQuote(creds.host)}`);
          if (creds.port) lines.push(`port=${creds.port}`);
          await conn.writeFile(cnf, `${lines.join('\n')}\n`, { mode: 0o600 });
          try {
            await this.sh(conn, [
              'bash',
              '-c',
              MYSQLDUMP_SCRIPT,
              'auto-wp-dump',
              mysqldump,
              cnf,
              creds.name,
              dest,
              iso,
            ]);
          } finally {
            await conn
              .remove(cnf)
              .catch((e) =>
                this.deps.logger.error(
                  { err: (e as Error).message },
                  'could not delete temporary mysql options file',
                ),
              );
          }
          return 'mysqldump';
        },
      });
    }
    strategies.push({
      name: 'agent db.dump',
      run: async () => {
        const r = await conn.call('db.dump', { dest, excludeTables: [] });
        return r.method === 'mysqldump' ? 'mysqldump' : 'native';
      },
    });

    let last: unknown;
    for (const s of strategies) {
      try {
        return await s.run();
      } catch (e) {
        last = e;
        this.deps.logger.warn(
          { strategy: s.name, err: (e as Error).message },
          'database dump strategy failed',
        );
        await conn.remove(dest).catch(() => {});
      }
    }
    throw new BackupError(`all database dump strategies failed: ${(last as Error).message}`);
  }

  private async sh(conn: SiteConnection, argv: string[], okCodes: number[] = [0]): Promise<void> {
    const r = await conn.exec(argv, { timeoutMs: 3 * 3600_000 });
    if (!okCodes.includes(r.exitCode)) {
      throw new BackupError(
        `${posix.basename(argv[0] ?? 'command')} exited ${r.exitCode}: ${trunc(r.stderr)}`,
      );
    }
  }

  // ---- files and hashing -----------------------------------------------------------------------

  private async archiveFiles(
    conn: SiteConnection,
    caps: Capabilities,
    dir: string,
    ctx: RunCtx,
  ): Promise<{ method: 'tar' | 'native'; count: number; bytes: number }> {
    const dest = posix.join(dir, FILES_FILE);
    if (caps.shell && caps.binaries.tar) {
      const argv = [
        caps.binaries.tar,
        '-czf',
        dest,
        ...ctx.excludes.map((e) => `--exclude=${e}`),
        '-C',
        caps.wpRoot,
        '.',
      ];
      // exit 1 = "file changed as we read it", normal on a live site
      await this.sh(conn, argv, [0, 1]);
      return { method: 'tar', count: ctx.count.fileCount, bytes: ctx.count.bytes };
    }
    const r = await conn.call('fs.archive', { sourceDir: caps.wpRoot, dest, excludes: ctx.excludes });
    return { method: 'native', count: r.fileCount, bytes: r.bytes };
  }

  private async hash(conn: SiteConnection, caps: Capabilities, path: string) {
    const bin = caps.binaries.sha256sum;
    if (caps.shell && bin) {
      const r = await conn.exec([bin, path]);
      const sha = /^([0-9a-f]{64})/.exec(r.stdout)?.[1];
      if (r.exitCode === 0 && sha) return { sha256: sha, bytes: (await conn.stat(path))?.size ?? 0 };
    }
    return conn.call('fs.sha256', { path });
  }

  private async coreVersion(conn: SiteConnection, caps: Capabilities): Promise<string> {
    try {
      const src = (await conn.readFile(posix.join(caps.wpRoot, 'wp-includes/version.php'))).toString();
      return /\$wp_version\s*=\s*'([^']+)'/.exec(src)?.[1] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ---- protection check ------------------------------------------------------------------------

  /** URLs that answered 2xx. 401/403/404 are the expected answers; network failures abort. */
  private async exposedUrls(site: SiteConfig, id: string): Promise<string[]> {
    const root = site.url.replace(/\/+$/, '');
    const exposed: string[] = [];
    for (const name of [MANIFEST_FILE, DB_FILE]) {
      const url = `${root}/${BACKUP_DIR_NAME}/${id}/${name}`;
      let status: number;
      try {
        const res = await this.deps.fetch(url, { method: 'GET', redirect: 'manual' });
        status = res.status;
        await res.body?.cancel().catch(() => {});
      } catch (e) {
        throw new ExposureError(
          `could not verify that ${url} is protected (${(e as Error).message}); the backup was removed`,
        );
      }
      if (status >= 200 && status < 300) exposed.push(url);
      else if (![401, 403, 404].includes(status)) {
        this.deps.logger.warn({ url, status }, 'unexpected status from backup protection check');
      }
    }
    return exposed;
  }

  // ---- list / pull / prune ---------------------------------------------------------------------

  private bases(caps: Capabilities): string[] {
    const out = [posix.join(caps.wpRoot, BACKUP_DIR_NAME)];
    if (caps.outsideDocrootDir) out.push(posix.join(caps.outsideDocrootDir, BACKUP_DIR_NAME));
    return [...new Set(out)];
  }

  private async listRemote(conn: SiteConnection, caps: Capabilities): Promise<BackupManifest[]> {
    const out: BackupManifest[] = [];
    for (const base of this.bases(caps)) {
      let entries: Awaited<ReturnType<SiteConnection['list']>>;
      try {
        entries = await conn.list(base);
      } catch {
        continue;
      }
      for (const e of entries) {
        const name = posix.basename(e.path);
        if (e.type !== 'dir' || !BACKUP_ID_RE.test(name)) continue;
        try {
          const raw = await conn.readFile(posix.join(base, name, MANIFEST_FILE));
          out.push(BackupManifestSchema.parse(JSON.parse(raw.toString())));
        } catch (err) {
          this.deps.logger.warn({ dir: e.path, err: (err as Error).message }, 'skipping unreadable backup');
        }
      }
    }
    return out.sort((a, b) => b.backupId.localeCompare(a.backupId));
  }

  async list(_site: SiteConfig, conn: SiteConnection): Promise<BackupManifest[]> {
    return this.listRemote(conn, await conn.probe());
  }

  async pull(site: SiteConfig, conn: SiteConnection, backupId: string): Promise<{ localDir: string }> {
    const caps = await conn.probe();
    const m = (await this.listRemote(conn, caps)).find((x) => x.backupId === backupId);
    if (!m) throw new BackupError(`backup ${backupId} not found on ${site.id}`);
    return { localDir: await pullBackup(conn, this.deps.dataDir, m.location, m) };
  }

  async prune(
    site: SiteConfig,
    conn: SiteConnection,
    keep: number,
    o: { dryRun?: boolean } = {},
  ): Promise<{ removed: string[] }> {
    if (!Number.isInteger(keep) || keep < 1) throw new BackupError('prune: keep must be an integer >= 1');
    const caps = await conn.probe();
    const all = await this.listRemote(conn, caps);
    const removed = selectPrune(
      all.map((m) => m.backupId),
      keep,
    );
    if (!o.dryRun) {
      for (const id of removed) {
        const m = all.find((x) => x.backupId === id);
        if (m) await conn.remove(m.location, { recursive: true });
      }
    }
    this.deps.logger.info({ siteId: site.id, removed, dryRun: !!o.dryRun }, 'prune');
    return { removed };
  }

  private async applyRetention(
    site: SiteConfig,
    conn: SiteConnection,
    caps: Capabilities,
    newId: string,
    retention: { remote: number; local: number },
  ): Promise<void> {
    const all = await this.listRemote(conn, caps);
    const remote = selectPrune(
      all.map((m) => m.backupId),
      Math.max(1, retention.remote),
      newId,
    );
    for (const id of remote) {
      const m = all.find((x) => x.backupId === id);
      if (m) await conn.remove(m.location, { recursive: true });
    }
    const local = selectPrune(
      await listLocalIds(this.deps.dataDir, site.id),
      Math.max(1, retention.local),
      newId,
    );
    await removeLocal(this.deps.dataDir, site.id, local);
  }

  // ---- dry run ---------------------------------------------------------------------------------

  private async preview(
    site: SiteConfig,
    conn: SiteConnection,
    caps: Capabilities,
    id: string,
    loc: Location,
    p: {
      info: RunCtx['info'];
      count: RunCtx['count'];
      excludes: string[];
      pull: boolean;
      retention: { remote: number; local: number };
      disk: BackupPreview['disk'];
    },
  ): Promise<BackupPreview> {
    const dir = posix.join(this.baseDir(caps, loc), id);
    const base = posix.dirname(dir);
    const existing = await this.listRemote(conn, caps);
    const remotePrune = selectPrune(
      [...existing.map((m) => m.backupId), id],
      Math.max(1, p.retention.remote),
      id,
    );
    const localPrune = selectPrune(
      [...(await listLocalIds(this.deps.dataDir, site.id)), id],
      Math.max(1, p.retention.local),
      id,
    );
    const dbStrategy =
      caps.shell && caps.wpCli.available
        ? 'wp db export | gzip'
        : caps.shell && caps.binaries.mysqldump && this.deps.dbCredentials
          ? 'mysqldump | gzip'
          : 'agent db.dump';
    const ops = [
      'probe capabilities',
      `check free disk space (need ~${p.disk.neededBytes} bytes)`,
      'acquire remote lock',
      `create ${dir}`,
      `write ${base}/.htaccess, index.php, web.config`,
      `dump database via ${dbStrategy} -> ${posix.join(dir, DB_FILE)}`,
      `archive files via ${caps.shell && caps.binaries.tar ? 'tar -czf' : 'agent fs.archive'} -> ${posix.join(dir, FILES_FILE)}`,
      'sha256 each artifact',
      `write ${MANIFEST_FILE}${this.deps.signManifest ? ` and ${SIG_FILE}` : ''}`,
      ...(loc === 'docroot' ? [`GET ${site.url}/${BACKUP_DIR_NAME}/${id}/ (expect 401/403/404)`] : []),
      ...(p.pull ? [`pull artifacts to ${localSiteDir(this.deps.dataDir, site.id)}/${id} and re-hash`] : []),
      ...(site.offsite.rcloneRemote ? [`rclone copy to ${site.offsite.rcloneRemote}`] : []),
      ...remotePrune.map((r) => `remove old remote backup ${r}`),
      ...localPrune.map((r) => `remove old local backup ${r}`),
      'release remote lock',
    ];
    return {
      dryRun: true,
      operations: ops,
      disk: p.disk,
      prune: { remote: remotePrune, local: localPrune },
      schemaVersion: 1,
      backupId: id,
      siteId: site.id,
      createdAt: this.deps.clock.now().toISOString(),
      toolVersion: TOOL_VERSION,
      location: dir,
      wp: { core: 'unknown', php: caps.phpVersion, db: `${p.info.server} ${p.info.version}` },
      method: { db: 'native', files: caps.shell && caps.binaries.tar ? 'tar' : 'native' },
      db: { tables: p.info.tables, charset: p.info.charset },
      files: { count: p.count.fileCount, bytes: p.count.bytes, excludes: p.excludes },
      artifacts: [],
    };
  }
}

interface RunCtx {
  info: { server: string; version: string; charset: string; tables: Array<{ name: string; rows: number }> };
  count: { fileCount: number; bytes: number };
  excludes: string[];
  say: (m: string) => void;
}

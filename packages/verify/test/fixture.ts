import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type BackupManifest, SiteConfigSchema } from '@auto-wp/contracts';
import { FakeClock, FakeSiteConnection, MemoryLogger } from '@auto-wp/contracts/fakes';
import { type BackupVerifierDeps, DefaultBackupVerifier } from '../src/index.js';
import { TarWalker } from '../src/tar.js';
import { buildDump, buildTar, type DumpTable, gz, sha256 } from './helpers.js';

export const SITE = SiteConfigSchema.parse({
  id: 'demo',
  name: 'Demo',
  url: 'https://example.com',
  transport: { kind: 'ssh', host: 'h', username: 'u', hostKeySha256: 'SHA256:abc', wpRoot: '/var/www/html' },
});
export const BACKUP_ID = '20261024T103012Z-7f3a9c';
export const REMOTE_DIR = `/var/www/html/auto-wp-backup/${BACKUP_ID}`;

export interface FixtureOptions {
  tables?: DumpTable[];
  files?: string[];
  /** Mutate artifact bytes before they are stored (manifest hashes the originals). */
  mutateDb?(b: Buffer): Buffer;
  mutateFiles?(b: Buffer): Buffer;
  dumpTerminator?: boolean;
  /** Replace the SQL text before gzipping, after the manifest is computed. */
  mutateSql?(s: string): string;
  manifestPatch?(m: BackupManifest): BackupManifest;
  live?: { files?: number; tables?: DumpTable[] };
  localCopy?: boolean;
  remoteCopy?: boolean;
}

export async function makeFixture(o: FixtureOptions = {}) {
  const tables = o.tables ?? [
    { name: 'wp_posts', rows: 10 },
    { name: 'wp_options', rows: 7 },
    { name: 'wp_actionscheduler_logs', rows: 100 },
  ];
  const files = o.files ?? ['index.php', 'wp-config.php', 'wp-content/a.txt', 'wp-content/b.txt'];
  const sql = buildDump(tables, { terminator: o.dumpTerminator });
  const goodDb = gz(buildDump(tables));
  const goodTar = gz(
    buildTar([{ name: 'wp-content/', type: '5' }, ...files.map((name) => ({ name, data: `x${name}` }))]),
  );
  let manifest: BackupManifest = {
    schemaVersion: 1,
    backupId: BACKUP_ID,
    siteId: SITE.id,
    createdAt: '2026-10-24T10:30:12Z',
    toolVersion: '0.1.0',
    location: REMOTE_DIR,
    wp: { core: '6.8', php: '8.2', db: '10.11' },
    method: { db: 'native', files: 'native' },
    db: { tables: tables.map((t) => ({ name: t.name, rows: t.rows })), charset: 'utf8mb4' },
    files: { count: files.length, bytes: 100, excludes: ['auto-wp-backup'] },
    artifacts: [
      { name: 'db.sql.gz', bytes: goodDb.length, sha256: sha256(goodDb) },
      { name: 'files.tar.gz', bytes: goodTar.length, sha256: sha256(goodTar) },
    ],
  };
  manifest = o.manifestPatch?.(manifest) ?? manifest;
  const db = o.mutateDb
    ? o.mutateDb(o.mutateSql ? gz(o.mutateSql(sql)) : goodDb)
    : o.mutateSql
      ? gz(o.mutateSql(sql))
      : goodDb;
  const tar = o.mutateFiles ? o.mutateFiles(goodTar) : goodTar;
  const manifestBytes = Buffer.from(JSON.stringify(manifest));

  const conn = new FakeSiteConnection('demo');
  const live = o.live ?? {};
  conn.onCall('fs.sha256', async (p, c) => {
    const d = c.files.get(c.resolve(p.path));
    if (!d) throw new Error('ENOENT');
    return { sha256: sha256(d), bytes: d.length };
  });
  conn.onCall('fs.testArchive', async (p, c) => {
    const d = c.files.get(c.resolve(p.path));
    if (!d) throw new Error('ENOENT');
    try {
      const w = new TarWalker();
      w.write(gunzipSync(d));
      return { ok: true, entries: w.finish().entries };
    } catch (e) {
      return { ok: false, entries: 0, error: String(e) };
    }
  });
  conn.onCall('fs.count', async () => ({ fileCount: live.files ?? files.length, bytes: 100 }));
  conn.onCall('db.info', async () => ({
    server: 'mariadb',
    version: '10.11',
    charset: 'utf8mb4',
    tables: (live.tables ?? tables).map((t) => ({ name: t.name, rows: t.rows })),
  }));

  const dataDir = await mkdtemp(join(tmpdir(), 'verify-test-'));
  const localDir = join(dataDir, 'backups', SITE.id, BACKUP_ID);
  if (o.remoteCopy !== false) {
    conn.seed({
      [`${REMOTE_DIR}/manifest.json`]: manifestBytes,
      [`${REMOTE_DIR}/db.sql.gz`]: db,
      [`${REMOTE_DIR}/files.tar.gz`]: tar,
    });
  }
  if (o.localCopy !== false) {
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, 'manifest.json'), manifestBytes);
    await writeFile(join(localDir, 'db.sql.gz'), db);
    await writeFile(join(localDir, 'files.tar.gz'), tar);
  }
  const logger = new MemoryLogger();
  const make = (extra: Partial<BackupVerifierDeps> = {}) =>
    new DefaultBackupVerifier({ logger, clock: new FakeClock('2026-10-24T11:00:00Z'), dataDir, ...extra });
  return { conn, dataDir, localDir, manifest, manifestBytes, logger, make, verifier: make(), db, tar };
}

export const byName = (r: { checks: { name: string }[] }, name: string) =>
  r.checks.find((c) => c.name === name) as
    | { name: string; ok: boolean; severity: string; details?: any }
    | undefined;

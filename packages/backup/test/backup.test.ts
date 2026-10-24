import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type BackupManifest, BackupManifestSchema } from '@auto-wp/contracts';
import { describe, expect, it, vi } from 'vitest';
import { HTACCESS, INDEX_PHP, isBackupPreview, selectPrune, WEB_CONFIG } from '../src/index.js';
import { DB_BYTES, FILES_BYTES, makeConn, makeService, makeSite, sha, statusFetch } from './helpers.js';

const ID = '20261024T103012Z-7f3a9c';
const DIR = `/var/www/html/auto-wp-backup/${ID}`;
const execArgvs = (c: ReturnType<typeof makeConn>) =>
  c.ops.filter((o) => o.op === 'exec').map((o) => (o.args as { argv: string[] }).argv);

function oldManifest(id: string): BackupManifest {
  return BackupManifestSchema.parse({
    schemaVersion: 1,
    backupId: id,
    siteId: 'demo',
    createdAt: '2026-01-01T00:00:00Z',
    toolVersion: '0.1.0',
    location: `/var/www/html/auto-wp-backup/${id}`,
    wp: { core: '6', php: '8', db: 'x' },
    method: { db: 'wpcli', files: 'tar' },
    db: { tables: [], charset: 'utf8mb4' },
    files: { count: 1, bytes: 1, excludes: [] },
    artifacts: [],
  });
}
const seedOld = (c: ReturnType<typeof makeConn>, ids: string[]) => {
  for (const id of ids) c.seed({ [`auto-wp-backup/${id}/manifest.json`]: JSON.stringify(oldManifest(id)) });
};

describe('create: strategies', () => {
  it('wp-cli: fixed bash script with positional args, no creds', async () => {
    const c = makeConn();
    const { svc } = await makeService();
    const m = await svc.create(makeSite(), c, { pull: false });
    const bash = execArgvs(c).find((a) => a[0] === 'bash') as string[];
    expect(bash.slice(0, 2)).toEqual(['bash', '-c']);
    expect(bash[2]).toContain('"$1" db export - --path="$2" --single-transaction');
    expect(bash[2]).not.toContain('/var/www');
    expect(bash.slice(3, 7)).toEqual([
      'auto-wp-dump',
      '/usr/local/bin/wp',
      '/var/www/html',
      `${DIR}/db.sql.gz`,
    ]);
    expect(bash[7]).toBe('2026-10-24T10:30:12.000Z');
    expect(m.method).toEqual({ db: 'wpcli', files: 'tar' });
    expect(m.backupId).toBe(ID);
    expect(m.wp.core).toBe('6.8.1');
  });

  it('tar argv has all excludes and uses -C wpRoot', async () => {
    const c = makeConn();
    const { svc } = await makeService();
    await svc.create(makeSite(), c, { pull: false });
    const tar = execArgvs(c).find((a) => a[0] === '/bin/tar') as string[];
    expect(tar.slice(0, 2)).toEqual(['/bin/tar', '-czf']);
    for (const e of [
      'auto-wp-backup',
      'auto-wp-agent/.data',
      'wp-content/cache',
      '*.log',
      'wp-content/uploads/backup*',
    ])
      expect(tar).toContain(`--exclude=${e}`);
    expect(tar.slice(-3)).toEqual(['-C', '/var/www/html', '.']);
  });

  it('mysqldump: 0600 options file, deleted, password never in argv/env', async () => {
    const c = makeConn({
      wpCli: { available: false },
      binaries: { tar: '/bin/tar', mysqldump: '/usr/bin/mysqldump' },
    });
    const envs: unknown[] = [];
    const orig = c.exec.bind(c);
    c.exec = async (argv, o) => {
      envs.push(o?.env);
      return orig(argv, o);
    };
    const { svc } = await makeService({
      dbCredentials: async () => ({ host: 'localhost', user: 'wpu', password: 'S3cr3t"pw', name: 'wpdb' }),
    });
    const m = await svc.create(makeSite(), c, { pull: false });
    expect(m.method.db).toBe('mysqldump');
    const argvs = execArgvs(c);
    expect(JSON.stringify(argvs)).not.toContain('S3cr3t');
    expect(JSON.stringify(envs)).not.toContain('S3cr3t');
    const write = c.ops.find(
      (o) => o.op === 'writeFile' && String((o.args as { path: string }).path).endsWith('.cnf'),
    );
    expect((write?.args as { mode: number }).mode).toBe(0o600);
    const bash = argvs.find((a) => a[0] === 'bash') as string[];
    expect(bash[4]).toBe('/usr/bin/mysqldump');
    expect(bash[5]).toMatch(/\.cnf$/);
    expect([...c.files.keys()].some((k) => k.endsWith('.cnf'))).toBe(false);
    expect(
      c.ops.some((o) => o.op === 'remove' && String((o.args as { path: string }).path).endsWith('.cnf')),
    ).toBe(true);
  });

  it('mysqldump credentials unavailable -> falls back to agent db.dump', async () => {
    const c = makeConn({
      wpCli: { available: false },
      binaries: { tar: '/bin/tar', mysqldump: '/usr/bin/mysqldump' },
    });
    const { svc } = await makeService({ dbCredentials: async () => undefined });
    const m = await svc.create(makeSite(), c, { pull: false });
    expect(m.method.db).toBe('native');
    expect(c.ops.some((o) => o.op === 'call:db.dump')).toBe(true);
  });

  it('no shell: db.dump and fs.archive', async () => {
    const c = makeConn({ shell: false, execEnabled: false });
    const { svc } = await makeService();
    const m = await svc.create(makeSite(), c, { pull: false });
    expect(m.method).toEqual({ db: 'native', files: 'native' });
    expect(c.ops.some((o) => o.op === 'exec')).toBe(false);
    expect(c.ops.find((o) => o.op === 'call:fs.archive')?.args).toMatchObject({
      sourceDir: '/var/www/html',
      dest: `${DIR}/files.tar.gz`,
    });
  });

  it('wp-cli failure falls back to the next strategy', async () => {
    const c = makeConn();
    c.onExec('bash', () => ({ exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1 }));
    const { svc } = await makeService();
    const m = await svc.create(makeSite(), c, { pull: false });
    expect(m.method.db).toBe('native');
  });
});

describe('create: manifest and protection', () => {
  it('writes a schema-valid manifest with hashes, rows, and signature', async () => {
    const c = makeConn();
    const signer = vi.fn(async (b: Buffer) => Buffer.from(`sig:${sha(b).slice(0, 8)}`));
    const { svc } = await makeService({ signManifest: signer });
    const m = await svc.create(makeSite(), c, { pull: false });
    const onDisk = BackupManifestSchema.parse(
      JSON.parse(c.files.get(`${DIR}/manifest.json`)?.toString() ?? ''),
    );
    expect(onDisk).toEqual(m);
    expect(m.artifacts).toEqual([
      { name: 'db.sql.gz', bytes: DB_BYTES.length, sha256: sha(DB_BYTES) },
      { name: 'files.tar.gz', bytes: FILES_BYTES.length, sha256: sha(FILES_BYTES) },
    ]);
    expect(m.db.tables).toEqual([
      { name: 'wp_posts', rows: 10 },
      { name: 'wp_options', rows: 200 },
    ]);
    expect(m.files).toMatchObject({ count: 100, bytes: 1_000_000 });
    expect(m.location).toBe(DIR);
    const sig = c.files.get(`${DIR}/manifest.json.sig`)?.toString() ?? '';
    const bytes = c.files.get(`${DIR}/manifest.json`) as Buffer;
    expect(Buffer.from(sig, 'base64').toString()).toBe(`sig:${sha(bytes).slice(0, 8)}`);
  });

  it('protection files have deny rules', async () => {
    const c = makeConn();
    const { svc } = await makeService();
    await svc.create(makeSite(), c, { pull: false });
    const base = '/var/www/html/auto-wp-backup';
    const ht = c.files.get(`${base}/.htaccess`)?.toString() ?? '';
    expect(ht).toBe(HTACCESS);
    expect(ht).toContain('Require all denied');
    expect(ht).toContain('Order deny,allow');
    expect(ht).toContain('Deny from all');
    expect(ht).toContain('Options -Indexes');
    expect(ht).toContain('<IfModule mod_authz_core.c>');
    expect(c.files.get(`${base}/index.php`)?.toString()).toBe(INDEX_PHP);
    expect(INDEX_PHP).toContain('http_response_code(403)');
    expect(c.files.get(`${base}/web.config`)?.toString()).toBe(WEB_CONFIG);
    expect(WEB_CONFIG).toContain('accessType="Deny"');
  });

  it('checks manifest.json and db.sql.gz without following redirects', async () => {
    const c = makeConn();
    const f = statusFetch(403);
    const { svc } = await makeService({ fetch: f });
    await svc.create(makeSite(), c, { pull: false });
    const calls = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.map((x) => x[0])).toEqual([
      `https://demo.test/auto-wp-backup/${ID}/manifest.json`,
      `https://demo.test/auto-wp-backup/${ID}/db.sql.gz`,
    ]);
    expect(calls.every((x) => x[1].redirect === 'manual')).toBe(true);
  });

  it('HTTP 200 -> deletes docroot folder and retries outside', async () => {
    const c = makeConn();
    const { svc } = await makeService({ fetch: statusFetch(200) });
    const m = await svc.create(makeSite(), c, { pull: false });
    expect(m.location).toBe(`/var/www/auto-wp-backup/${ID}`);
    expect(
      [...c.files.keys()].filter((k) => k.startsWith('/var/www/html/auto-wp-backup/') && k.includes(ID)),
    ).toEqual([]);
    expect(c.files.has(`/var/www/auto-wp-backup/${ID}/manifest.json`)).toBe(true);
  });

  it('HTTP 200 and no outside dir -> exposure error and cleanup', async () => {
    const c = makeConn({ outsideDocrootDir: undefined });
    const { svc } = await makeService({ fetch: statusFetch(200) });
    await expect(svc.create(makeSite(), c, { pull: false })).rejects.toThrow(/publicly downloadable/);
    expect([...c.files.keys()].filter((k) => k.includes(ID))).toEqual([]);
    expect(c.ops.filter((o) => o.op === 'call:lock.release')).toHaveLength(1);
  });

  it('backupLocation outside skips the HTTP check', async () => {
    const c = makeConn();
    const f = statusFetch(200);
    const { svc } = await makeService({ fetch: f });
    const m = await svc.create(makeSite({ backupLocation: 'outside' }), c, { pull: false });
    expect(m.location).toBe(`/var/www/auto-wp-backup/${ID}`);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('create: safety', () => {
  it('aborts when free disk is below 1.2x estimate, before locking or writing', async () => {
    const c = makeConn({ diskFreeBytes: 1_000_000 });
    const { svc } = await makeService();
    await expect(svc.create(makeSite(), c)).rejects.toThrow(/not enough free disk space/);
    expect(c.ops.some((o) => ['call:lock.acquire', 'writeFile', 'mkdir'].includes(o.op))).toBe(false);
  });

  it('releases the lock when the backup fails', async () => {
    const c = makeConn();
    c.onCall('db.dump', () => {
      throw new Error('nope');
    });
    c.onExec('bash', () => ({ exitCode: 2, stdout: '', stderr: 'x', durationMs: 1 }));
    const { svc } = await makeService();
    await expect(svc.create(makeSite(), c, { pull: false })).rejects.toThrow();
    expect(c.ops.filter((o) => o.op === 'call:lock.release')).toHaveLength(1);
    expect([...c.files.keys()].filter((k) => k.includes(ID))).toEqual([]);
  });

  it('releases the lock on success and refuses when the lock is held', async () => {
    const c = makeConn();
    const { svc } = await makeService();
    await svc.create(makeSite(), c, { pull: false });
    expect(c.ops.filter((o) => o.op === 'call:lock.release')).toHaveLength(1);

    const c2 = makeConn();
    c2.onCall('lock.acquire', () => ({ acquired: false, holder: 'other' }));
    await expect(svc.create(makeSite(), c2)).rejects.toThrow(/lock/);
    expect(c2.ops.some((o) => o.op === 'call:lock.release')).toBe(false);
  });
});

describe('pull', () => {
  it('downloads and verifies into dataDir', async () => {
    const c = makeConn();
    const { svc, dataDir } = await makeService();
    await svc.create(makeSite(), c);
    const dir = join(dataDir, 'backups', 'demo', ID);
    expect((await readFile(join(dir, 'db.sql.gz'))).equals(DB_BYTES)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['db.sql.gz', 'files.tar.gz', 'manifest.json']);
  });

  it('hash mismatch -> error and no local dir', async () => {
    const c = makeConn();
    const orig = c.download.bind(c);
    c.download = async (p, o) => {
      if (p.endsWith('files.tar.gz')) c.files.set(c.resolve(p), Buffer.from('corrupt'));
      return orig(p, o);
    };
    const { svc, dataDir } = await makeService();
    await expect(svc.create(makeSite(), c)).rejects.toThrow(/does not match manifest/);
    expect(await readdir(join(dataDir, 'backups', 'demo'))).toEqual([]);
  });

  it('pull() by id works and unknown id errors', async () => {
    const c = makeConn();
    const { svc, dataDir } = await makeService();
    await svc.create(makeSite(), c, { pull: false });
    const r = await svc.pull(makeSite(), c, ID);
    expect(r.localDir).toBe(join(dataDir, 'backups', 'demo', ID));
    await expect(svc.pull(makeSite(), c, '20200101T000000Z-aaaaaa')).rejects.toThrow(/not found/);
  });

  it('runs rclone copy when configured', async () => {
    const rclone = vi.fn(async () => {});
    const { svc, dataDir } = await makeService({ rclone });
    await svc.create(makeSite({ offsite: { rcloneRemote: 'b2:bucket/' } }), makeConn());
    expect(rclone).toHaveBeenCalledWith([
      'copy',
      join(dataDir, 'backups', 'demo', ID),
      `b2:bucket/demo/${ID}`,
    ]);
  });
});

describe('retention, list, prune', () => {
  it('selectPrune keeps newest N and never the protected id', () => {
    const ids = ['a1', 'a2', 'a3', 'a4'];
    expect(selectPrune(ids, 2)).toEqual(['a2', 'a1']);
    expect(selectPrune(ids, 1, 'a1')).toEqual(['a3', 'a2']);
  });

  it('create prunes remote beyond policy.retention.remote and local beyond local', async () => {
    const c = makeConn();
    const old = ['20260101T000000Z-aaaaaa', '20260102T000000Z-aaaaaa', '20260103T000000Z-aaaaaa'];
    seedOld(c, old);
    const { svc, dataDir } = await makeService();
    for (const id of old) await mkdir(join(dataDir, 'backups', 'demo', id), { recursive: true });
    await svc.create(makeSite({ policy: { retention: { remote: 2, local: 2 } } }), c);
    const left = (await svc.list(makeSite(), c)).map((m) => m.backupId);
    expect(left).toEqual([ID, old[2]]);
    expect((await readdir(join(dataDir, 'backups', 'demo'))).sort()).toEqual([old[2], ID]);
  });

  it('list parses manifests newest first and skips junk', async () => {
    const c = makeConn();
    seedOld(c, ['20260101T000000Z-aaaaaa', '20260301T000000Z-bbbbbb']);
    c.seed({ 'auto-wp-backup/20260201T000000Z-cccccc/manifest.json': '{bad' });
    const { svc } = await makeService();
    expect((await svc.list(makeSite(), c)).map((m) => m.backupId)).toEqual([
      '20260301T000000Z-bbbbbb',
      '20260101T000000Z-aaaaaa',
    ]);
  });

  it('prune dryRun removes nothing; real run removes', async () => {
    const c = makeConn();
    const ids = ['20260101T000000Z-aaaaaa', '20260102T000000Z-aaaaaa', '20260103T000000Z-aaaaaa'];
    seedOld(c, ids);
    const { svc } = await makeService();
    expect(await svc.prune(makeSite(), c, 1, { dryRun: true })).toEqual({ removed: [ids[1], ids[0]] });
    expect(c.ops.some((o) => o.op === 'remove')).toBe(false);
    await svc.prune(makeSite(), c, 1);
    expect((await svc.list(makeSite(), c)).map((m) => m.backupId)).toEqual([ids[2]]);
    await expect(svc.prune(makeSite(), c, 0)).rejects.toThrow();
  });
});

describe('dryRun', () => {
  it('performs no writes anywhere and lists operations', async () => {
    const c = makeConn();
    const f = statusFetch(403);
    const { svc, dataDir } = await makeService({ fetch: f });
    const m = await svc.create(makeSite(), c, { dryRun: true });
    expect(isBackupPreview(m)).toBe(true);
    if (!isBackupPreview(m)) return;
    const writes = [
      'writeFile',
      'mkdir',
      'rename',
      'remove',
      'exec',
      'download',
      'call:lock.acquire',
      'call:db.dump',
      'call:fs.archive',
    ];
    expect(c.ops.filter((o) => writes.includes(o.op))).toEqual([]);
    expect(f).not.toHaveBeenCalled();
    expect(m.operations.join('\n')).toMatch(/htaccess/);
    expect(m.operations.join('\n')).toMatch(/wp db export/);
    expect(m.disk.ok).toBe(true);
    await expect(stat(join(dataDir, 'backups'))).rejects.toThrow();
  });
});

import { createHash } from 'node:crypto';
import type { BackupManifest } from '@auto-wp/contracts';
import { FakeClock, MemoryLogger } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { DefaultRestoreService, RestoreRefusedError } from '../src/index.js';
import { fakeWp, site } from './harness.js';

const ID = '20261024T103012Z-7f3a9c';
const DIR = `auto-wp-backup/${ID}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup() {
  const { conn, state } = fakeWp();
  // files.tar.gz in the harness' archive format: JSON of relative path -> base64 content.
  const filesArchive = JSON.stringify({
    'wp-config.php': Buffer.from('<?php // restored config').toString('base64'),
    'index.php': Buffer.from('<?php // restored index').toString('base64'),
    'wp-content/plugins/foo/foo.php': Buffer.from('foo 0.9.0').toString('base64'),
  });
  const dbDump = 'db-from-backup';
  const manifest: BackupManifest = {
    schemaVersion: 1,
    backupId: ID,
    siteId: site.id,
    createdAt: '2026-10-24T10:30:12Z',
    toolVersion: '0.1.0',
    location: `/var/www/html/${DIR}`,
    wp: { core: '6.5.0', php: '8.2', db: '8.0' },
    method: { db: 'native', files: 'native' },
    db: { tables: [{ name: 'wp_posts', rows: 10 }], charset: 'utf8mb4' },
    files: { count: 3, bytes: 100, excludes: ['auto-wp-backup'] },
    artifacts: [
      { name: 'db.sql.gz', bytes: dbDump.length, sha256: sha(dbDump) },
      { name: 'files.tar.gz', bytes: filesArchive.length, sha256: sha(filesArchive) },
    ],
  };
  conn.seed({
    [`${DIR}/manifest.json`]: JSON.stringify(manifest),
    [`${DIR}/db.sql.gz`]: dbDump,
    [`${DIR}/files.tar.gz`]: filesArchive,
    'auto-wp-agent/agent.php': '<?php // agent',
    'wp-content/plugins/extra/extra.php': 'added after backup',
  });
  conn.onCall('db.info', () => ({
    server: 'mysql',
    version: '8.0',
    charset: 'utf8mb4',
    tables: [{ name: 'wp_posts', rows: 10 }],
  }));
  const clock = new FakeClock('2026-10-24T12:00:00Z');
  const svc = new DefaultRestoreService({ logger: new MemoryLogger(), clock });
  return { conn, state, svc, clock, manifest };
}

const approve = (planHash: string, approved = true) => ({ approved, by: 'owner', planHash, at: 'now' });
const MUTATING = [
  'writeFile',
  'mkdir',
  'rename',
  'remove',
  'call:db.import',
  'call:fs.extract',
  'call:wp.maintenance',
];
const mutations = (conn: ReturnType<typeof fakeWp>['conn']) =>
  conn.ops.filter((o) => MUTATING.includes(o.op));

describe('DefaultRestoreService', () => {
  it('plan lists steps and a stable sha256 plan hash', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    expect(p.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.steps[0]).toBe('maintenance on');
    expect(p.steps).toContain(`db import ${DIR}/db.sql.gz`);
    expect(p.steps.at(-2)).toBe('maintenance off');
    t.clock.advance(60_000);
    expect((await t.svc.plan(site, t.conn, ID, 'full')).planHash).toBe(p.planHash);
    expect((await t.svc.plan(site, t.conn, ID, 'db')).planHash).not.toBe(p.planHash);
    expect(mutations(t.conn)).toEqual([]);
  });

  it('refuses without approval', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    await expect(t.svc.execute(site, t.conn, p, approve(p.planHash, false))).rejects.toBeInstanceOf(
      RestoreRefusedError,
    );
    expect(mutations(t.conn)).toEqual([]);
  });

  it('refuses with a mismatched plan hash', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    await expect(t.svc.execute(site, t.conn, p, approve('0'.repeat(64)))).rejects.toThrow(
      /different plan hash/,
    );
    // Tampered plan (steps or scope changed but hash kept) is also refused.
    await expect(
      t.svc.execute(site, t.conn, { ...p, scope: 'db' }, approve(p.planHash)),
    ).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(mutations(t.conn)).toEqual([]);
  });

  it('refuses on artifact hash mismatch before touching anything', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    t.conn.seed({ [`${DIR}/db.sql.gz`]: 'tampered' });
    await expect(t.svc.execute(site, t.conn, p, approve(p.planHash))).rejects.toThrow(/sha256 mismatch/);
    expect(mutations(t.conn)).toEqual([]);
    expect(t.conn.ops.some((o) => o.op === 'call:lock.acquire')).toBe(false);
  });

  it('executes in order: maintenance on, db import, staging extract, move aside, swap, flush, off', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    t.conn.ops.length = 0;
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.ok).toBe(true);
    expect(v.checks.map((c) => c.name)).toEqual([
      'artifacts.sha256',
      'files.swap',
      'maintenance.off',
      'db.rowCounts',
    ]);

    const seq = t.conn.ops
      .filter((o) => o.op.startsWith('call:') || o.op === 'rename')
      .map((o) =>
        o.op === 'rename'
          ? `rename ${(o.args as { from: string }).from.replace('/var/www/html/', '')}`
          : o.op,
      )
      .filter((s) => !s.startsWith('call:fs.sha256'));
    const idx = (s: string) => seq.findIndex((x) => x.startsWith(s));
    expect(idx('call:lock.acquire')).toBe(0);
    expect(seq[1]).toBe('call:wp.maintenance');
    expect(seq[2]).toBe('call:db.dump');
    expect(seq[3]).toBe('call:db.import');
    expect(seq[4]).toBe('call:fs.extract');
    expect(idx('rename wp-config.php')).toBeGreaterThan(4);
    expect(idx(`rename ${DIR}/restore-staging/`)).toBeGreaterThan(idx('rename wp-config.php'));
    expect(idx('call:cache.flush')).toBeGreaterThan(idx(`rename ${DIR}/restore-staging/`));
    expect(seq.slice(-3)).toEqual(['call:wp.maintenance', 'call:db.info', 'call:lock.release']);

    expect(callArgs(t.conn, 'fs.extract')).toEqual({
      archive: `${DIR}/files.tar.gz`,
      destDir: `${DIR}/restore-staging`,
      overwrite: true,
    });
    expect(t.state.db).toBe('db-from-backup');
    // Restored tree in place; current tree moved aside; backups and agent left alone.
    const f = (p: string) => t.conn.files.get(t.conn.resolve(p))?.toString();
    expect(f('wp-config.php')).toBe('<?php // restored config');
    expect(f('wp-content/plugins/extra/extra.php')).toBeUndefined();
    expect(f(`${DIR}/pre-restore-20261024T120000Z/wp-content/plugins/extra/extra.php`)).toBe(
      'added after backup',
    );
    expect(f('auto-wp-agent/agent.php')).toBe('<?php // agent');
    expect(f(`${DIR}/manifest.json`)).toBeDefined();
  });

  it('does not try to carry over excluded paths inside the agent directory (the agent refuses them)', async () => {
    const t = setup();
    const manifest = {
      ...t.manifest,
      files: { ...t.manifest.files, excludes: ['auto-wp-backup', 'auto-wp-agent/.data'] },
    };
    t.conn.seed({ [`${DIR}/manifest.json`]: JSON.stringify(manifest) });
    const jailed = (p: string) => p.startsWith('auto-wp-agent') || p.includes('/auto-wp-agent');
    const stat = t.conn.stat.bind(t.conn);
    t.conn.stat = async (p: string) => {
      if (jailed(p)) throw new Error('path_jail: agent directory is off-limits');
      return stat(p);
    };
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    expect(p.steps.find((x) => x.startsWith('files carry over'))).not.toContain('auto-wp-agent/.data');
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('reports row-count mismatches', async () => {
    const t = setup();
    t.conn.onCall('db.info', () => ({
      server: 'mysql',
      version: '8',
      charset: 'x',
      tables: [{ name: 'wp_posts', rows: 9 }],
    }));
    const p = await t.svc.plan(site, t.conn, ID, 'db');
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'db.rowCounts')?.ok).toBe(false);
    expect(t.conn.ops.some((o) => o.op === 'rename')).toBe(false);
  });

  it('a failure mid-restore still disables maintenance and releases the lock', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    t.conn.failNext('call:db.import', new Error('mysql gone'));
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'restore.execute')?.details).toMatchObject({ step: 'db import' });
    const m = t.conn.ops
      .filter((o) => o.op === 'call:wp.maintenance')
      .map((o) => (o.args as { enabled: boolean }).enabled);
    expect(m).toEqual([true, false]);
    expect(t.conn.ops.some((o) => o.op === 'call:lock.release')).toBe(true);
    expect(t.conn.ops.some((o) => o.op === 'rename')).toBe(false);
  });

  it('puts the live tree back if moving it aside fails part-way', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'files');
    const orig = t.conn.rename.bind(t.conn);
    let n = 0;
    t.conn.rename = async (from, to) => {
      if (to.includes('pre-restore') && ++n === 2) throw new Error('EXDEV');
      return orig(from, to);
    };
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.ok).toBe(false);
    const f = (q: string) => t.conn.files.get(t.conn.resolve(q))?.toString();
    expect(f('wp-config.php')).toBe('<?php // secrets');
    expect(f('index.php')).toBe('<?php // index');
  });

  it('a file-phase failure after the DB import re-imports the pre-restore DB', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'full');
    t.conn.failNext('call:fs.extract', new Error('disk full'));
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'db.revert')?.ok).toBe(true);
    expect(t.state.db).toBe('db-original');
    expect(t.conn.files.get(t.conn.resolve('wp-config.php'))?.toString()).toBe('<?php // secrets');
  });

  it('undoes both move phases if moving staging into place fails part-way', async () => {
    const t = setup();
    const p = await t.svc.plan(site, t.conn, ID, 'files');
    const orig = t.conn.rename.bind(t.conn);
    let n = 0;
    t.conn.rename = async (from, to) => {
      if (from.includes('restore-staging/') && ++n === 2) throw new Error('EACCES');
      return orig(from, to);
    };
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.ok).toBe(false);
    const f = (q: string) => t.conn.files.get(t.conn.resolve(q))?.toString();
    expect(f('wp-config.php')).toBe('<?php // secrets');
    expect(f('index.php')).toBe('<?php // index');
    expect(f('wp-content/plugins/extra/extra.php')).toBe('added after backup');
  });

  it('carries excluded paths and a missing wp-config.php over from the live tree', async () => {
    const t = setup();
    const archive = JSON.stringify({
      'index.php': Buffer.from('<?php // restored index').toString('base64'),
    });
    const manifest = {
      ...t.manifest,
      files: { ...t.manifest.files, excludes: ['auto-wp-backup', 'wp-content/uploads', '*.log', 'cache'] },
      artifacts: [
        t.manifest.artifacts[0]!,
        { name: 'files.tar.gz', bytes: archive.length, sha256: sha(archive) },
      ],
    };
    t.conn.seed({
      [`${DIR}/manifest.json`]: JSON.stringify(manifest),
      [`${DIR}/files.tar.gz`]: archive,
      'wp-content/uploads/2026/a.jpg': 'jpeg',
      'cache/x': 'cached',
    });
    const p = await t.svc.plan(site, t.conn, ID, 'files');
    expect(p.steps.some((s) => s.includes('pattern excludes): *.log'))).toBe(true);
    const v = await t.svc.execute(site, t.conn, p, approve(p.planHash));
    expect(v.ok).toBe(true);
    const f = (q: string) => t.conn.files.get(t.conn.resolve(q))?.toString();
    expect(f('index.php')).toBe('<?php // restored index');
    expect(f('wp-config.php')).toBe('<?php // secrets');
    expect(f('wp-content/uploads/2026/a.jpg')).toBe('jpeg');
    expect(f('cache/x')).toBe('cached');
    expect(f('wp-content/plugins/foo/foo.php')).toBeUndefined();
  });

  it('keeps a top-level agent file in place and refuses when the agent is nested in wp-content', async () => {
    const t = setup();
    const fileAgent = {
      ...site,
      transport: { ...site.transport, endpoint: 'https://example.com/auto-wp-agent.php' },
    };
    t.conn.seed({ 'auto-wp-agent.php': 'agent' });
    const p = await t.svc.plan(fileAgent as typeof site, t.conn, ID, 'files');
    await t.svc.execute(fileAgent as typeof site, t.conn, p, approve(p.planHash));
    expect(t.conn.files.get(t.conn.resolve('auto-wp-agent.php'))?.toString()).toBe('agent');

    const nested = {
      ...site,
      transport: { ...site.transport, endpoint: 'https://example.com/wp-content/aw/agent.php' },
    };
    await expect(t.svc.plan(nested as typeof site, t.conn, ID, 'full')).rejects.toThrow(/wp-content\/aw/);
    expect((await t.svc.plan(nested as typeof site, t.conn, ID, 'db')).steps).toBeDefined();
  });
});

function callArgs(conn: ReturnType<typeof fakeWp>['conn'], action: string) {
  return conn.ops.find((o) => o.op === `call:${action}`)?.args;
}

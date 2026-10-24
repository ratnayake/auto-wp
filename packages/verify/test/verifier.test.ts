import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_ID, byName, makeFixture, REMOTE_DIR, SITE } from './fixture.js';
import { buildTar, gz, sha256 } from './helpers.js';

describe('DefaultBackupVerifier', () => {
  it('passes a good backup, remote and local', async () => {
    const f = await makeFixture();
    const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.verifiedAt).toBe('2026-10-24T11:00:00.000Z');
    const names = r.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'manifest.schema',
        'artifact.sha256:db.sql.gz',
        'artifact.sha256:files.tar.gz',
        'archive.integrity',
        'files.count',
        'files.count.live',
        'db.terminator',
        'db.tables',
        'db.rows:wp_posts',
        'db.rows:wp_options',
      ]),
    );
    expect(byName(r, 'archive.integrity')?.details.local.files).toBe(4);
    expect(byName(r, 'archive.integrity')?.details.remote.ok).toBe(true);
  });

  it('works with the backup in the outside-docroot location', async () => {
    const f = await makeFixture({ remoteCopy: false });
    for (const [k, v] of [...f.conn.files]) f.conn.files.set(k, v);
    const outside = `/var/www/auto-wp-backup/${BACKUP_ID}`;
    f.conn.seed({
      [`${outside}/manifest.json`]: f.manifestBytes,
      [`${outside}/db.sql.gz`]: f.db,
      [`${outside}/files.tar.gz`]: f.tar,
    });
    const r = await f.verifier.verify({ ...SITE, backupLocation: 'outside' }, f.conn, BACKUP_ID);
    expect(r.ok).toBe(true);
    expect(byName(r, 'artifact.sha256:db.sql.gz')?.details.remote.ok).toBe(true);
  });

  it('verifies a remote-only backup by streaming the dump from the server', async () => {
    const f = await makeFixture({ localCopy: false });
    const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
    expect(r.ok).toBe(true);
    expect(byName(r, 'artifact.sha256:db.sql.gz')?.details.local).toBe('absent');
    expect(f.conn.ops.some((o) => o.op === 'download')).toBe(true);
    expect(byName(r, 'files.count')).toMatchObject({ ok: false, severity: 'warn' });
  });

  it('verifies a local-only backup (remote gone)', async () => {
    const f = await makeFixture({ remoteCopy: false });
    const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
    expect(r.ok).toBe(true);
    expect(byName(r, 'artifact.sha256:db.sql.gz')?.details.remote).toBe('unavailable');
  });

  it('fails manifest.schema when no manifest exists or it is malformed', async () => {
    const none = await makeFixture({ remoteCopy: false, localCopy: false });
    expect(byName(await none.verifier.verify(SITE, none.conn, BACKUP_ID), 'manifest.schema')?.ok).toBe(false);

    const bad = await makeFixture();
    bad.conn.seed({ [`${REMOTE_DIR}/manifest.json`]: '{"schemaVersion":2}' });
    const r = await bad.verifier.verify(SITE, bad.conn, BACKUP_ID);
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(1);

    const wrongSite = await makeFixture({ manifestPatch: (m) => ({ ...m, siteId: 'other' }) });
    expect((await wrongSite.verifier.verify(SITE, wrongSite.conn, BACKUP_ID)).ok).toBe(false);
  });

  it('rejects path-like backup ids and artifact names', async () => {
    const f = await makeFixture();
    expect((await f.verifier.verify(SITE, f.conn, '../etc')).ok).toBe(false);
    const g = await makeFixture({
      manifestPatch: (m) => ({ ...m, artifacts: [{ name: '../x', bytes: 1, sha256: 'a'.repeat(64) }] }),
    });
    const r = await g.verifier.verify(SITE, g.conn, BACKUP_ID);
    expect(byName(r, 'artifact.sha256:../x')?.ok).toBe(false);
  });

  describe('signature', () => {
    it('verifies a valid signature and fails an invalid one', async () => {
      const f = await makeFixture();
      f.conn.seed({ [`${REMOTE_DIR}/manifest.json.sig`]: 'sig' });
      let seen: Buffer | undefined;
      const ok = f.make({ signatureVerifier: { verify: (m, s) => ((seen = m), s.toString() === 'sig') } });
      expect(byName(await ok.verify(SITE, f.conn, BACKUP_ID), 'manifest.signature')?.ok).toBe(true);
      expect(seen?.equals(f.manifestBytes)).toBe(true);
      const bad = f.make({ signatureVerifier: { verify: async () => false } });
      const r = await bad.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'manifest.signature')?.ok).toBe(false);
      expect(r.ok).toBe(false);
    });

    it('is an error when a verifier is given but the manifest is unsigned, and absent without one', async () => {
      const f = await makeFixture();
      const r = await f.make({ signatureVerifier: { verify: () => true } }).verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'manifest.signature')).toMatchObject({ ok: false, severity: 'error' });
      expect(r.ok).toBe(false);
      expect(byName(await f.verifier.verify(SITE, f.conn, BACKUP_ID), 'manifest.signature')).toBeUndefined();
    });
  });

  describe('artifact checksums', () => {
    it('detects a flipped byte in the remote copy', async () => {
      const f = await makeFixture();
      const p = `${REMOTE_DIR}/db.sql.gz`;
      const d = Buffer.from(f.conn.files.get(p) as Buffer);
      d[d.length - 12] = (d[d.length - 12] ?? 0) ^ 1;
      f.conn.files.set(p, d);
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      const c = byName(r, 'artifact.sha256:db.sql.gz');
      expect(c?.ok).toBe(false);
      expect(c?.details.remote.ok).toBe(false);
      expect(c?.details.local.ok).toBe(true);
      expect(r.ok).toBe(false);
    });

    it('detects a flipped byte in the local copy', async () => {
      const f = await makeFixture();
      const p = join(f.localDir, 'files.tar.gz');
      const d = Buffer.from(f.tar);
      d[20] = (d[20] ?? 0) ^ 0xff;
      await writeFile(p, d);
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'artifact.sha256:files.tar.gz')?.details.local.ok).toBe(false);
      expect(r.ok).toBe(false);
    });

    it('falls back to sha256sum when fs.sha256 is unavailable', async () => {
      const f = await makeFixture();
      f.conn.onCall('fs.sha256', async () => {
        throw new Error('agent missing');
      });
      const sums = new Map<string, string>();
      for (const a of f.manifest.artifacts) sums.set(`${REMOTE_DIR}/${a.name}`, a.sha256);
      f.conn.onExec('sha256sum', (argv) => ({
        exitCode: 0,
        stdout: `${sums.get(argv[2] as string)}  ${argv[2]}\n`,
        stderr: '',
        durationMs: 1,
      }));
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'artifact.sha256:db.sql.gz')?.details.remote.ok).toBe(true);
      expect(r.ok).toBe(true);
    });
  });

  describe('archive', () => {
    it('fails integrity on a corrupt gzip even if the checksum is not consulted', async () => {
      const f = await makeFixture({
        mutateFiles: (b) => {
          const c = Buffer.from(b);
          c[Math.floor(c.length / 2)] = (c[Math.floor(c.length / 2)] ?? 0) ^ 0xff;
          return c;
        },
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'archive.integrity')?.ok).toBe(false);
      expect(byName(r, 'files.count')?.ok).toBe(false);
      expect(r.ok).toBe(false);
    });

    it('uses gzip -t and tar -tzf when fs.testArchive is unavailable', async () => {
      const f = await makeFixture({ localCopy: false });
      f.conn.onCall('fs.testArchive', async () => {
        throw new Error('no agent');
      });
      f.conn.onExec('gzip', () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }));
      f.conn.onExec('tar', () => ({ exitCode: 0, stdout: 'a\nb\nc\n', stderr: '', durationMs: 1 }));
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'archive.integrity')?.details.remote).toEqual({ ok: true, entries: 3 });
      f.conn.onExec('gzip', () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'invalid compressed data',
        durationMs: 1,
      }));
      const bad = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(bad, 'archive.integrity')?.ok).toBe(false);
    });

    it('fails integrity when the tar has no end-of-archive marker (cut at an entry boundary)', async () => {
      const cut = gz(buildTar([{ name: 'a.txt', data: 'hi' }], false));
      const f = await makeFixture({ files: ['a.txt'], mutateFiles: () => cut });
      const m = {
        ...f.manifest,
        artifacts: f.manifest.artifacts.map((a) =>
          a.name === 'files.tar.gz' ? { ...a, bytes: cut.length, sha256: sha256(cut) } : a,
        ),
      };
      const bytes = Buffer.from(JSON.stringify(m));
      f.conn.seed({ [`${REMOTE_DIR}/manifest.json`]: bytes });
      await writeFile(join(f.localDir, 'manifest.json'), bytes);
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'artifact.sha256:files.tar.gz')?.ok).toBe(true);
      expect(byName(r, 'archive.integrity')).toMatchObject({ ok: false, severity: 'error' });
      expect(r.ok).toBe(false);
    });

    it('fails files.count when the archive disagrees with the manifest', async () => {
      const f = await makeFixture({ manifestPatch: (m) => ({ ...m, files: { ...m.files, count: 9 } }) });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'files.count')).toMatchObject({ ok: false, severity: 'error' });
    });

    it('only warns about live drift beyond the tolerance', async () => {
      const files = Array.from({ length: 2000 }, (_, i) => `f${i}.txt`);
      const within = await makeFixture({ files, live: { files: 2000 + 9 } }); // 0.5% of 2000 = 10
      const rw = await within.verifier.verify(SITE, within.conn, BACKUP_ID);
      expect(byName(rw, 'files.count.live')?.ok).toBe(true);

      const drift = await makeFixture({ files, live: { files: 2000 + 50 } });
      const rd = await drift.verifier.verify(SITE, drift.conn, BACKUP_ID);
      expect(byName(rd, 'files.count.live')).toMatchObject({ ok: false, severity: 'warn' });
      expect(rd.ok).toBe(true);
    });
  });

  describe('database', () => {
    it('fails when the terminator is missing', async () => {
      const f = await makeFixture({
        dumpTerminator: false,
        mutateSql: (s) => s.replace(/-- Dump completed.*\n/, ''),
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'db.terminator')?.ok).toBe(false);
      expect(r.ok).toBe(false);
    });

    it('fails when the dump is truncated mid-INSERT (valid gzip)', async () => {
      const f = await makeFixture({
        mutateSql: (s) => s.slice(0, s.indexOf('INSERT INTO `wp_options`') + 60),
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'db.terminator')?.ok).toBe(false);
      expect(byName(r, 'db.terminator')?.details.error).toMatch(/truncated/);
      expect(byName(r, 'db.rows:wp_options')?.ok).toBe(false);
    });

    it('fails when a table is missing from the dump', async () => {
      const f = await makeFixture({
        mutateSql: (s) =>
          s.replace(/DROP TABLE IF EXISTS `wp_options`;\nCREATE TABLE `wp_options`/, 'CREATE TABLE `other`'),
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      const c = byName(r, 'db.tables');
      expect(c?.ok).toBe(false);
      expect(c?.details.missingFromDump).toEqual(['wp_options']);
      expect(c?.details.notInManifest).toEqual(['other']);
    });

    it('fails on a row-count mismatch for a normal table', async () => {
      const f = await makeFixture({
        manifestPatch: (m) => ({
          ...m,
          db: { ...m.db, tables: m.db.tables.map((t) => (t.name === 'wp_posts' ? { ...t, rows: 11 } : t)) },
        }),
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'db.rows:wp_posts')).toMatchObject({ ok: false, severity: 'error' });
      expect(byName(r, 'db.rows:wp_options')?.ok).toBe(true);
    });

    it('compares volatile tables to live data with tolerance, at warn severity', async () => {
      // dump has 100 rows; live 120 (within max(25, 20%)) vs 400 (outside)
      const near = await makeFixture({
        live: {
          tables: [
            { name: 'wp_posts', rows: 10 },
            { name: 'wp_options', rows: 7 },
            { name: 'wp_actionscheduler_logs', rows: 120 },
          ],
        },
      });
      expect(
        byName(await near.verifier.verify(SITE, near.conn, BACKUP_ID), 'db.rows:wp_actionscheduler_logs')?.ok,
      ).toBe(true);
      const far = await makeFixture({
        live: {
          tables: [
            { name: 'wp_posts', rows: 10 },
            { name: 'wp_options', rows: 7 },
            { name: 'wp_actionscheduler_logs', rows: 400 },
          ],
        },
      });
      const r = await far.verifier.verify(SITE, far.conn, BACKUP_ID);
      expect(byName(r, 'db.rows:wp_actionscheduler_logs')).toMatchObject({ ok: false, severity: 'warn' });
      expect(r.ok).toBe(true);
    });

    it('warns (not errors) when live tables differ from the manifest', async () => {
      const f = await makeFixture({
        live: {
          tables: [
            { name: 'wp_posts', rows: 10 },
            { name: 'wp_options', rows: 7 },
            { name: 'wp_actionscheduler_logs', rows: 100 },
            { name: 'wp_new', rows: 1 },
          ],
        },
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'db.tables.live')).toMatchObject({ ok: false, severity: 'warn' });
      expect(r.ok).toBe(true);
    });

    it('still verifies the dump when live db.info fails', async () => {
      const f = await makeFixture();
      f.conn.onCall('db.info', async () => {
        throw new Error('db down');
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(r.ok).toBe(true);
      expect(byName(r, 'db.tables.live')).toBeUndefined();
    });

    it('reports a corrupt dump gzip as a failing check, not an exception', async () => {
      const f = await makeFixture({
        mutateDb: (b) => {
          const c = Buffer.from(b);
          c[Math.floor(c.length / 2)] = (c[Math.floor(c.length / 2)] ?? 0) ^ 0xff;
          return c;
        },
      });
      const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID);
      expect(byName(r, 'db.terminator')?.ok).toBe(false);
      expect(byName(r, 'artifact.sha256:db.sql.gz')?.ok).toBe(false);
      expect(r.ok).toBe(false);
    });
  });
});

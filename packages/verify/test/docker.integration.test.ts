import { execFileSync, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliDockerRunner, scanGzipSqlStream } from '../src/index.js';
import { BACKUP_ID, byName, makeFixture, SITE } from './fixture.js';
import { gz } from './helpers.js';

const hasDocker = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', 'mariadb:10.11'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const docker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

describe.skipIf(!hasDocker)('mariadb:10.11 integration', () => {
  it('deep.restore imports a generated dump and matches manifest counts', async () => {
    const f = await makeFixture({
      tables: [
        { name: 'wp_posts', rows: 120 },
        { name: 'wp_options', rows: 33 },
        { name: 'wp_actionscheduler_logs', rows: 50 },
      ],
    });
    const v = f.make({ dockerRunner: new CliDockerRunner() });
    const r = await v.verify(SITE, f.conn, BACKUP_ID, { deep: true });
    expect(byName(r, 'deep.restore')?.details, JSON.stringify(byName(r, 'deep.restore'))).toMatchObject({
      mismatches: [],
    });
    expect(byName(r, 'deep.restore')?.ok).toBe(true);
    expect(r.ok).toBe(true);
  }, 240_000);

  it('deep.restore fails when the manifest overstates a row count', async () => {
    const f = await makeFixture({
      manifestPatch: (m) => ({
        ...m,
        db: {
          ...m.db,
          tables: m.db.tables.map((t) => (t.name === 'wp_posts' ? { ...t, rows: t.rows + 1 } : t)),
        },
      }),
    });
    const r = await f
      .make({ dockerRunner: new CliDockerRunner() })
      .verify(SITE, f.conn, BACKUP_ID, { deep: true });
    expect(byName(r, 'deep.restore')?.ok).toBe(false);
  }, 240_000);

  describe('real mysqldump output', () => {
    const name = `auto-wp-verify-it-${process.pid}`;
    beforeAll(async () => {
      const run = docker(
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-e',
        'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1',
        '-e',
        'MARIADB_DATABASE=wp',
        'mariadb:10.11',
      );
      if (run.status !== 0) throw new Error(run.stderr);
      for (let i = 0; i < 90; i++) {
        if (docker('exec', name, 'mariadb', '-uroot', '-h127.0.0.1', '-e', 'SELECT 1').status === 0) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('mariadb not ready');
    }, 150_000);
    afterAll(() => {
      docker('rm', '-f', name);
    });

    it('scanner row counts equal COUNT(*) and the terminator is found', async () => {
      const nasty = [
        "it\\'s a ),( trap; -- not a comment",
        'back\\\\slash',
        '/* not a comment */ INSERT INTO `evil` VALUES (1);',
        'line1\\nline2',
        '',
      ];
      let sql =
        'CREATE TABLE `wp_posts` (id INT PRIMARY KEY, body LONGTEXT, bin BLOB) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;' +
        "CREATE TABLE `we``ird` (id INT) COMMENT 'has ; and (x)';" +
        'CREATE TABLE `empty_t` (id INT);';
      const values: string[] = [];
      for (let i = 0; i < 3000; i++) {
        values.push(
          `(${i}, '${nasty[i % nasty.length]}', ${i % 7 === 0 ? 'NULL' : `0x${(i % 256).toString(16).padStart(2, '0')}28293b`})`,
        );
      }
      sql += `INSERT INTO wp_posts VALUES ${values.join(',')};INSERT INTO \`we\`\`ird\` VALUES (1),(2);`;
      const seed = docker('exec', '-i', name, 'mariadb', '-uroot', 'wp', '-e', sql);
      expect(seed.status, seed.stderr).toBe(0);

      const dump = docker(
        'exec',
        name,
        'mariadb-dump',
        '-uroot',
        '--single-transaction',
        '--routines',
        '--triggers',
        'wp',
      );
      expect(dump.status, dump.stderr).toBe(0);
      expect(dump.stdout).toContain('-- Dump completed');

      const scan = await scanGzipSqlStream(Readable.from([gz(dump.stdout)]));
      expect(scan.terminator).toBe(true);
      expect(scan.truncated).toBe(false);
      expect([...scan.createTables].sort()).toEqual(['empty_t', 'we`ird', 'wp_posts']);
      expect(scan.rowsPerTable.get('wp_posts')).toBe(3000);
      expect(scan.rowsPerTable.get('we`ird')).toBe(2);
      expect(scan.rowsPerTable.has('evil')).toBe(false);
      expect(scan.rowsPerTable.has('empty_t')).toBe(false);

      // Cross-check against the live server.
      const cnt = docker(
        'exec',
        name,
        'mariadb',
        '-uroot',
        'wp',
        '-N',
        '-B',
        '-e',
        'SELECT COUNT(*) FROM wp_posts',
      );
      expect(Number(cnt.stdout.trim())).toBe(scan.rowsPerTable.get('wp_posts'));
    }, 120_000);
  });
});

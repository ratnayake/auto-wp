import { describe, expect, it } from 'vitest';
import { makeConn, makeService, makeSite } from './helpers.js';

const ID = '20260101T000000Z-aaaaaa';
const manifest = (over: Record<string, unknown>) =>
  JSON.stringify({
    schemaVersion: 1,
    backupId: ID,
    siteId: 'demo',
    createdAt: '2026-01-01T00:00:00Z',
    toolVersion: '0.1.0',
    location: '/var/www/html',
    wp: { core: '6', php: '8', db: 'x' },
    method: { db: 'wpcli', files: 'tar' },
    db: { tables: [], charset: 'utf8mb4' },
    files: { count: 1, bytes: 1, excludes: [] },
    artifacts: [],
    ...over,
  });

describe('untrusted manifests', () => {
  it('rejects traversal in artifact names, mismatching siteId/backupId', async () => {
    const c = makeConn();
    const bad = {
      '20260101T000000Z-aaaaaa': { artifacts: [{ name: '../../x', bytes: 1, sha256: 'a'.repeat(64) }] },
      '20260102T000000Z-aaaaaa': { siteId: '../..' },
      '20260103T000000Z-aaaaaa': { backupId: '20260109T000000Z-bbbbbb' },
    } as Record<string, Record<string, unknown>>;
    for (const [dir, over] of Object.entries(bad)) {
      c.seed({ [`auto-wp-backup/${dir}/manifest.json`]: manifest(over) });
    }
    const { svc, logger } = await makeService();
    expect(await svc.list(makeSite(), c)).toEqual([]);
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(3);
    await expect(svc.pull(makeSite(), c, ID)).rejects.toThrow(/not found/);
  });

  it('prune and retention delete the computed folder, never manifest.location', async () => {
    const c = makeConn();
    c.seed({ 'wp-config.php': '<?php', [`auto-wp-backup/${ID}/manifest.json`]: manifest({}) });
    c.seed({ '20260102T000000Z-aaaaaa': '' });
    c.seed({
      'auto-wp-backup/20260102T000000Z-aaaaaa/manifest.json': manifest({
        backupId: '20260102T000000Z-aaaaaa',
      }),
    });
    const { svc } = await makeService();
    await svc.prune(makeSite(), c, 1);
    const removes = c.ops.filter((o) => o.op === 'remove').map((o) => (o.args as { path: string }).path);
    expect(removes).toEqual([`/var/www/html/auto-wp-backup/${ID}`]);
    expect(c.files.has('/var/www/html/wp-config.php')).toBe(true);
  });
});

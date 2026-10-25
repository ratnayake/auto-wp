import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SiteConfig, SiteConfigSchema } from '@auto-wp/contracts';
import { FakeClock, FakeSiteConnection, MemoryLogger } from '@auto-wp/contracts/fakes';
import { vi } from 'vitest';
import { type BackupServiceDeps, DefaultBackupService } from '../src/index.js';

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function makeSite(over: Record<string, unknown> = {}): SiteConfig {
  return SiteConfigSchema.parse({
    id: 'demo',
    name: 'Demo',
    url: 'https://demo.test',
    transport: {
      kind: 'ssh',
      host: 'h',
      username: 'u',
      hostKeySha256: 'SHA256:abc',
      wpRoot: '/var/www/html',
    },
    ...over,
  });
}

export const DB_BYTES = Buffer.from('gzdb');
export const FILES_BYTES = Buffer.from('gztar');

/** Fake connection scripted for a healthy shell+wp-cli host. */
export function makeConn(caps = {}): FakeSiteConnection {
  const c = new FakeSiteConnection('demo', 'ssh', caps);
  c.seed({ 'wp-includes/version.php': "<?php $wp_version = '6.8.1';" });
  c.onCall('fs.count', () => ({ fileCount: 100, bytes: 1_000_000 }));
  c.onCall('db.info', () => ({
    server: 'MariaDB',
    version: '10.6',
    charset: 'utf8mb4',
    tables: [
      { name: 'wp_posts', rows: 10 },
      { name: 'wp_options', rows: 200 },
    ],
  }));
  c.onCall('lock.acquire', () => ({ acquired: true }));
  c.onCall('lock.release', () => ({ released: true }));
  c.onCall('fs.sha256', (p, conn) => {
    const d = conn.files.get(conn.resolve(p.path));
    if (!d) throw new Error(`no such file ${p.path}`);
    return { sha256: sha(d), bytes: d.length };
  });
  c.onCall('db.dump', (p, conn) => {
    conn.files.set(conn.resolve(p.dest), DB_BYTES);
    return { tables: [], bytes: DB_BYTES.length, sha256: sha(DB_BYTES), method: 'native' as const };
  });
  c.onCall('fs.archive', (p, conn) => {
    conn.files.set(conn.resolve(p.dest), FILES_BYTES);
    return { fileCount: 100, bytes: 1_000_000, archiveBytes: FILES_BYTES.length, sha256: sha(FILES_BYTES) };
  });
  c.onExec('bash', (argv, _o, conn) => {
    const dest = argv.find((a) => a.endsWith('db.sql.gz'));
    if (dest) conn.files.set(conn.resolve(dest), DB_BYTES);
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
  });
  c.onExec('/bin/tar', (argv, _o, conn) => {
    const i = argv.indexOf('-czf');
    conn.files.set(conn.resolve(argv[i + 1] as string), FILES_BYTES);
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
  });
  return c;
}

export const statusFetch = (status: number | ((url: string) => number)) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    return new Response(null, { status: typeof status === 'function' ? status(u) : status });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

export async function makeService(over: Partial<BackupServiceDeps> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autowp-backup-'));
  const logger = new MemoryLogger();
  const clock = new FakeClock('2026-10-24T10:30:12Z');
  const fetchMock = over.fetch ?? statusFetch(403);
  const svc = new DefaultBackupService({
    logger,
    clock,
    fetch: fetchMock,
    dataDir,
    randomHex: () => '7f3a9c',
    ...over,
  });
  return { svc, dataDir, logger, clock, fetchMock };
}

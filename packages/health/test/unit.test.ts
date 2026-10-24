import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HealthSnapshot, PageProbe } from '@auto-wp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultHealthChecker, diffPngs, extractFatalLines, normalizeText } from '../src/index.js';
import { ctx, type Fixture, serveLogs, site, solidPng, startFixture, tmpDir } from './helpers.js';

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(async () => {
  await fx.close();
});

const probe = (o: Partial<PageProbe> = {}): PageProbe => ({
  url: 'http://x/',
  status: 200,
  ttfbMs: 10,
  totalMs: 100,
  criticalError: false,
  consoleErrors: [],
  failedRequests: [],
  ...o,
});
const snap = (pages: PageProbe[], id = 's'): HealthSnapshot => ({
  snapshotId: id,
  siteId: 'demo',
  label: id,
  takenAt: '2026-01-01T00:00:00Z',
  pages,
  logOffsets: {},
});

async function checker(extra: Record<string, unknown> = {}) {
  const c = ctx();
  const artifactsDir = await tmpDir();
  return {
    ...c,
    artifactsDir,
    hc: new DefaultHealthChecker({ logger: c.logger, clock: c.clock, artifactsDir, ...extra }),
  };
}

describe('http probes', () => {
  it('probes good, broken, redirect pages with nocache params and warns without browser', async () => {
    const { hc, conn, logger } = await checker();
    const s = await hc.snapshot(
      site(fx.url, { healthUrls: ['/broken', '/redirect', '/phpfatal', '/loop'], logFiles: [] }),
      conn,
      'before',
    );
    const by = (p: string) => s.pages.find((x) => x.url === `${fx.url}${p}`);
    expect(by('/')?.status).toBe(200);
    expect(by('/')?.criticalError).toBe(false);
    expect(by('/broken')).toMatchObject({ status: 500, criticalError: true });
    expect(by('/redirect')?.status).toBe(200);
    expect(by('/phpfatal')?.criticalError).toBe(true);
    expect(by('/loop')?.status).toBe(302);
    expect(s.snapshotId).toMatch(/^before-\d+$/);
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);
    const h = fx.hits.find((x) => x.url.startsWith('/?autowp_nocache='));
    expect(h?.cacheControl).toBe('no-cache');
  });

  it('records slow response timing', async () => {
    const { hc, conn } = await checker();
    const s = await hc.snapshot(site(fx.url, { healthUrls: ['/slow'], logFiles: [] }), conn, 'x');
    expect(s.pages.find((p) => p.url.endsWith('/slow'))?.totalMs).toBeGreaterThanOrEqual(380);
  });

  it('sends the bypass cookie when provided', async () => {
    const { hc, conn } = await checker({ bypassCookie: () => 'tok123' });
    fx.hits.length = 0;
    await hc.snapshot(site(fx.url, { logFiles: [] }), conn, 'x');
    expect(fx.hits[0]?.cookie).toBe('autowp_bypass=tok123');
  });
});

describe('quick status regression', () => {
  it('flags 2xx -> 5xx and new critical error', async () => {
    const { hc, conn } = await checker();
    const st = site(fx.url, { logFiles: [] });
    const base = snap([probe({ url: `${fx.url}/broken` })]);
    const r = await hc.quick(st, conn, base);
    expect(r.ok).toBe(false);
    expect(r.pages[0]?.problems.length).toBe(2);
  });
});

describe('logs', () => {
  it('records offsets, reads only new bytes, tolerates missing, handles rotation', async () => {
    const { hc, conn } = await checker();
    const logs = new Map([['wp-content/debug.log', '[x] PHP Fatal error: old one\n']]);
    serveLogs(conn, logs);
    const st = site(fx.url, { logFiles: ['wp-content/debug.log', 'error_log'] });
    const base = await hc.snapshot(st, conn, 'b');
    expect(base.logOffsets).toEqual({
      'wp-content/debug.log': logs.get('wp-content/debug.log')?.length,
      error_log: 0,
    });
    expect((await hc.quick(st, conn, base)).newLogErrors).toEqual([]);

    logs.set(
      'wp-content/debug.log',
      `${logs.get('wp-content/debug.log')}[t1] PHP Fatal error: boom\n[t2] PHP Fatal error: boom\n[t3] PHP Notice: meh\n[t4] PHP Warning: include(x.php) failed\n`,
    );
    const r = await hc.quick(st, conn, base);
    expect(r.ok).toBe(false);
    expect(r.newLogErrors).toEqual([
      'wp-content/debug.log: PHP Fatal error: boom',
      'wp-content/debug.log: PHP Warning: include(x.php) failed',
    ]);

    // rotation: file shrinks below the offset, so it is read from 0
    logs.set('wp-content/debug.log', 'PHP Parse error: fresh\n');
    const rot = await hc.quick(st, conn, base);
    expect(rot.newLogErrors).toEqual(['wp-content/debug.log: PHP Parse error: fresh']);
  });

  it('caps and dedupes extracted lines', () => {
    const data = Array.from({ length: 200 }, (_, i) => `PHP Fatal error: e${i % 80}`).join('\n');
    expect(extractFatalLines(data)).toHaveLength(50);
    expect(extractFatalLines('Uncaught Exception\nnothing')).toEqual(['Uncaught Exception']);
  });
});

describe('normalizeText', () => {
  it('collapses whitespace and replaces volatile tokens', () => {
    const a = normalizeText('Posted  on March 3, 2025 at 10:15 pm\n\n\n  nonce a1b2c3d4e5f6a7b8c9d0 \tend');
    expect(a).toBe('Posted on <DATE> at <TIME>\n\nnonce <HEX> end');
    expect(normalizeText('2025-01-02T10:00:00Z x 5/6/2024')).toBe('<DATE> x <DATE>');
    expect(normalizeText('short abc123 words')).toBe('short abc123 words');
    expect(normalizeText('tok Ab12Cd34Ef56Gh78Ij90')).toBe('tok <TOKEN>');
  });
});

describe('pixel diff', () => {
  it('identical, small change, size mismatch', () => {
    const a = solidPng(100, 100, [255, 255, 255]);
    expect(diffPngs(a, a).pct).toBe(0);
    const small = diffPngs(a, solidPng(100, 100, [255, 255, 255], { x: 0, y: 0, w: 10, h: 10 }));
    expect(small.pct).toBe(1);
    const mism = diffPngs(a, solidPng(100, 150, [255, 255, 255]));
    expect(mism.pct).toBeCloseTo(33.33, 1);
  });
});

describe('compare thresholds', () => {
  async function withShots(a: Buffer, b: Buffer, ba: Partial<PageProbe> = {}, aa: Partial<PageProbe> = {}) {
    const k = await checker();
    const dir = await tmpDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.png'), a);
    await writeFile(join(dir, 'b.png'), b);
    await writeFile(join(dir, 'a.txt'), 'hello\nworld');
    await writeFile(join(dir, 'b.txt'), 'hello\nthere');
    const before = snap(
      [probe({ screenshotPaths: { desktop: join(dir, 'a.png') }, textPath: join(dir, 'a.txt'), ...ba })],
      'b',
    );
    const after = snap(
      [probe({ screenshotPaths: { desktop: join(dir, 'b.png') }, textPath: join(dir, 'b.txt'), ...aa })],
      'a',
    );
    return { k, before, after };
  }
  const T = { pixelDiffPct: 2, slowdownFactor: 1.5, slowdownMinMs: 300 };
  const white = solidPng(100, 100, [255, 255, 255]);

  it('flags pixel diff above threshold but stays ok by default', async () => {
    const { k, before, after } = await withShots(
      white,
      solidPng(100, 100, [255, 255, 255], { x: 0, y: 0, w: 50, h: 10 }),
    );
    const r = await k.hc.compare(before, after, T);
    expect(r.pages[0]?.pixelDiffPct?.desktop).toBe(5);
    expect(r.pages[0]?.problems.join()).toMatch(/desktop screenshot differs by 5%/);
    expect(r.pages[0]?.diffImagePaths?.desktop).toBeTruthy();
    expect(r.pages[0]?.textDiff).toContain('-world');
    expect(r.pages[0]?.textDiff).toContain('+there');
    expect(r.ok).toBe(true);
  });

  it('visualChangesFail makes visual problems fail', async () => {
    const k = await checker({ visualChangesFail: true });
    const { before, after } = await withShots(
      white,
      solidPng(100, 100, [255, 255, 255], { x: 0, y: 0, w: 50, h: 10 }),
    );
    expect((await k.hc.compare(before, after, T)).ok).toBe(false);
  });

  it('below threshold has no problems', async () => {
    const { k, before, after } = await withShots(
      white,
      solidPng(100, 100, [255, 255, 255], { x: 0, y: 0, w: 10, h: 10 }),
    );
    expect((await k.hc.compare(before, after, T)).pages[0]?.problems).toEqual([]);
  });

  it('slowdown uses max(before*(factor-1), minMs)', async () => {
    const k = await checker();
    const mk = (b: number, a: number) =>
      k.hc.compare(snap([probe({ totalMs: b })]), snap([probe({ totalMs: a })]), T);
    expect((await mk(100, 350)).pages[0]?.problems).toEqual([]); // +250 < 300
    expect((await mk(100, 450)).pages[0]?.problems[0]).toMatch(/slower/); // +350 > 300
    expect((await mk(2000, 2900)).pages[0]?.problems).toEqual([]); // +900 < 1000
    expect((await mk(2000, 3100)).pages[0]?.problems[0]).toMatch(/slower/);
    expect((await mk(2000, 3100)).ok).toBe(true);
  });

  it('functional failures make ok false; new console errors reported', async () => {
    const k = await checker();
    const r = await k.hc.compare(
      snap([probe({ consoleErrors: ['old'] })]),
      snap([
        probe({ status: 500, criticalError: true, consoleErrors: ['old', 'new'], failedRequests: ['f'] }),
      ]),
      T,
    );
    expect(r.ok).toBe(false);
    expect(r.pages[0]).toMatchObject({
      statusChanged: true,
      newConsoleErrors: ['new'],
      newFailedRequests: ['f'],
    });
    // pre-existing 500 is not a regression
    const same = await k.hc.compare(snap([probe({ status: 500 })]), snap([probe({ status: 500 })]), T);
    expect(same.ok).toBe(true);
  });
});

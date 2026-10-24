import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultHealthChecker, launchChromium } from '../src/index.js';
import { ctx, site, tmpDir } from './helpers.js';

let canLaunch = false;
beforeAll(async () => {
  try {
    const b = await launchChromium();
    await b.close();
    canLaunch = true;
  } catch {
    canLaunch = false;
  }
});

const server = createServer((req, res) => {
  if (req.url?.startsWith('/missing')) {
    res.writeHead(404);
    return void res.end('{}');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url?.startsWith('/styled')) {
    res.end(`<!doctype html><style>@keyframes m{from{margin-left:0}to{margin-left:200px}}
      .a{animation:m 1s infinite;width:50px;height:50px;background:red}</style>
      <h1>Styled</h1><div class="a"></div><p class="ad">Ad ${Math.random()}</p>
      <p>Updated March 3, 2025 10:15 am</p>
      <script>console.error('boom'); fetch('/missing.json'); </script>`);
  } else {
    res.end('<!doctype html><h1>Home</h1>');
  }
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('playwright snapshot', () => {
  it('captures screenshots, text, console errors; compare is stable', async (t) => {
    if (!canLaunch) return t.skip();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const c = ctx();
    const artifactsDir = await tmpDir();
    const hc = new DefaultHealthChecker({
      logger: c.logger,
      clock: c.clock,
      artifactsDir,
      browser: launchChromium,
    });
    const st = site(url, { healthUrls: ['/styled'], maskSelectors: ['.ad'], logFiles: [] });
    c.conn.onCall('logs.tail', () => {
      throw new Error('ENOENT');
    });
    const a = await hc.snapshot(st, c.conn, 'before');
    c.clock.advance(1000);
    const b = await hc.snapshot(st, c.conn, 'after');
    const p = a.pages.find((x) => x.url.endsWith('/styled'));
    expect(p?.screenshotPaths?.desktop).toBeTruthy();
    expect(p?.screenshotPaths?.mobile).toBeTruthy();
    expect(p?.consoleErrors.join()).toContain('boom');
    expect(p?.failedRequests.join()).toContain('/missing.json');
    expect(await readFile(p?.textPath as string, 'utf8')).toContain('Updated <DATE> <TIME>');
    const r = await hc.compare(a, b, { pixelDiffPct: 2, slowdownFactor: 1.5, slowdownMinMs: 300 });
    const sp = r.pages.find((x) => x.url.endsWith('/styled'));
    expect(sp?.pixelDiffPct?.desktop).toBe(0);
    expect(sp?.pixelDiffPct?.mobile).toBe(0);
    expect(sp?.textDiff).toBeUndefined();
    expect(sp?.newConsoleErrors).toEqual([]);
  });
});

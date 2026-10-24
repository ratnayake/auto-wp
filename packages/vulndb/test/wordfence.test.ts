import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock, MemoryLogger } from '@auto-wp/contracts/fakes';
import { afterEach, describe, expect, it } from 'vitest';
import { TopLevelValueSplitter } from '../src/json-stream.js';
import { WordfenceProvider } from '../src/wordfence.js';
import { startServer, type TestServer, tmpCache } from './helpers.js';

const feedPath = new URL('./fixtures/wordfence-feed.json', import.meta.url);
let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

async function feedServer(opts: { status?: () => number } = {}) {
  const body = await readFile(feedPath);
  srv = await startServer((req, res) => {
    const status = opts.status?.() ?? 200;
    if (status !== 200) {
      res.writeHead(status).end();
      return;
    }
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { ETag: '"v1"', 'Content-Type': 'application/json' });
    // Write in tiny chunks to exercise the streaming splitter across boundaries.
    for (let i = 0; i < body.length; i += 97) res.write(body.subarray(i, i + 97));
    res.end();
  });
  return srv;
}

const make = async (url: string, clock = new FakeClock()) => {
  const cacheDir = await tmpCache();
  const logger = new MemoryLogger();
  return {
    cacheDir,
    clock,
    logger,
    mk: () => new WordfenceProvider({ apiKey: 'k', cacheDir, clock, logger, feedUrl: `${url}/feed` }),
  };
};

describe('WordfenceProvider', () => {
  it('maps records for core/plugin/theme and normalises wildcards', async () => {
    const s = await feedServer();
    const { mk } = await make(s.url);
    const p = mk();

    const cf7 = await p.lookup('plugin', 'contact-form-7');
    expect(cf7.map((v) => v.cve).sort()).toEqual(['CVE-2023-6449', 'CVE-2024-0001']);
    const up = cf7.find((v) => v.cve === 'CVE-2023-6449');
    expect(up).toMatchObject({
      source: 'wordfence',
      fixedIn: '5.8.4',
      cvss: { score: 9.8, rating: 'Critical' },
      affected: [{ from: '*', fromInclusive: true, to: '5.8.3', toInclusive: true }],
    });

    const theme = await p.lookup('theme', 'twentytwentyfour');
    expect(theme).toHaveLength(1);
    expect(theme[0]?.cve).toBeUndefined();
    expect(theme[0]?.fixedIn).toBe('1.1');

    const core = await p.lookup('core', 'wordpress');
    expect(core[0]).toMatchObject({ cve: 'CVE-2024-31210', fixedIn: '6.4.5' });
    expect(core[0]?.affected).toHaveLength(2);

    const unpatched = await p.lookup('plugin', 'unpatched-gallery');
    expect(unpatched[0]?.fixedIn).toBeUndefined();
    expect(unpatched[0]?.affected).toEqual([{ from: '*', fromInclusive: true, to: '*', toInclusive: true }]);

    // One record covering two software entries yields one vuln each; tricky title survives.
    expect((await p.lookup('plugin', 'plugin-a'))[0]?.title).toContain('{ braces }');
    expect(await p.lookup('theme', 'theme-b')).toHaveLength(1);
    expect(await p.lookup('plugin', 'nope')).toEqual([]);
  });

  it('sends the bearer key, writes a compact cache and reuses it within 24h', async () => {
    const s = await feedServer();
    const { mk, cacheDir, clock } = await make(s.url);
    await mk().lookup('plugin', 'x');
    expect(s.requests[0]?.headers.authorization).toBe('Bearer k');
    expect((await stat(join(cacheDir, 'wordfence-v3.json'))).isFile()).toBe(true);

    clock.advance(23 * 3600_000);
    await mk().lookup('plugin', 'x'); // new instance reads the disk cache
    expect(s.requests).toHaveLength(1);
  });

  it('revalidates with If-None-Match after 24h and handles 304', async () => {
    const s = await feedServer();
    const { mk, clock } = await make(s.url);
    await mk().lookup('plugin', 'x');
    clock.advance(25 * 3600_000);
    const p = mk();
    const r = await p.lookup('plugin', 'contact-form-7');
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]?.headers['if-none-match']).toBe('"v1"');
    expect(r).toHaveLength(2);
    // fetchedAt was bumped, so no further request
    await mk().lookup('plugin', 'x');
    expect(s.requests).toHaveLength(2);
  });

  it('serves a stale index when refresh fails, and throws when there is none', async () => {
    let status = 200;
    const s = await feedServer({ status: () => status });
    const { mk, clock, logger } = await make(s.url);
    await mk().lookup('plugin', 'x');
    clock.advance(25 * 3600_000);
    status = 503;
    expect(await mk().lookup('plugin', 'contact-form-7')).toHaveLength(2);
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);

    const fresh = await make(s.url);
    await expect(fresh.mk().lookup('plugin', 'x')).rejects.toThrow(/Wordfence feed unavailable: HTTP 503/);
  });
});

describe('TopLevelValueSplitter', () => {
  it('splits objects and arrays regardless of chunking, ignoring braces in strings', () => {
    const text = '{"a":{"t":"}{\\"]"},"b":[1,{"c":2}],"n":5}';
    for (const size of [1, 2, 3, 7, 100]) {
      const sp = new TopLevelValueSplitter();
      const out: string[] = [];
      for (let i = 0; i < text.length; i += size) sp.push(text.slice(i, i + size), (r) => out.push(r));
      expect(out).toEqual(['{"t":"}{\\"]"}', '[1,{"c":2}]']);
    }
  });
});

import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SiteConfig, SiteConfigSchema } from '@auto-wp/contracts';
import { FakeClock, FakeSiteConnection, MemoryLogger } from '@auto-wp/contracts/fakes';
import { PNG } from 'pngjs';

export interface Fixture {
  url: string;
  hits: Array<{ url: string; cookie?: string; cacheControl?: string }>;
  state: { homeBody: string };
  close(): Promise<void>;
}

const PAGE = (body: string, extra = '') =>
  `<!doctype html><html><head><title>t</title>${extra}</head><body>${body}</body></html>`;

export async function startFixture(): Promise<Fixture> {
  const hits: Fixture['hits'] = [];
  const state = { homeBody: PAGE('<h1>Hello</h1><p>Welcome</p>') };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push({
      url: req.url ?? '',
      cookie: req.headers.cookie,
      cacheControl: req.headers['cache-control'],
    });
    const html = (code: number, body: string) => {
      res.writeHead(code, { 'content-type': 'text/html' });
      res.end(body);
    };
    switch (u.pathname) {
      case '/':
        return html(200, state.homeBody);
      case '/broken':
        return html(500, PAGE('<p>There has been a critical error on this website.</p>'));
      case '/phpfatal':
        return html(200, PAGE('<b>Fatal error:</b> Uncaught Error in /x.php'));
      case '/slow':
        return void setTimeout(() => html(200, PAGE('slow')), 400);
      case '/redirect':
        res.writeHead(302, { location: '/redirect2' });
        return res.end();
      case '/redirect2':
        res.writeHead(301, { location: '/' });
        return res.end();
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        return res.end();
      default:
        return html(404, PAGE('nope'));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    state,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function site(url: string, o: Partial<SiteConfig> = {}): SiteConfig {
  return SiteConfigSchema.parse({
    id: 'demo',
    name: 'Demo',
    url,
    transport: {
      kind: 'ssh',
      host: 'h',
      username: 'u',
      hostKeySha256: 'SHA256:abc',
      wpRoot: '/var/www/html',
    },
    healthUrls: ['/'],
    ...o,
  });
}

export async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'autowp-health-'));
}

export function ctx() {
  return { logger: new MemoryLogger(), clock: new FakeClock(), conn: new FakeSiteConnection('demo') };
}

/** Script logs.tail over an in-memory map of path -> content. */
export function serveLogs(conn: FakeSiteConnection, logs: Map<string, string>): void {
  conn.onCall('logs.tail', (p) => {
    const content = logs.get(p.path);
    if (content === undefined) throw new Error('ENOENT');
    const buf = Buffer.from(content);
    const rotated = p.fromOffset > buf.length;
    const from = rotated ? 0 : p.fromOffset;
    const slice = buf.subarray(from, from + (p.maxBytes ?? 1024 * 1024));
    return { data: slice.toString(), nextOffset: from + slice.length, size: buf.length, rotated };
  });
}

export function solidPng(
  w: number,
  h: number,
  rgb: [number, number, number],
  rect?: { x: number; y: number; w: number; h: number },
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inRect = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const i = (y * w + x) * 4;
      const c = inRect ? [0, 0, 0] : rgb;
      png.data[i] = c[0] as number;
      png.data[i + 1] = c[1] as number;
      png.data[i + 2] = c[2] as number;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

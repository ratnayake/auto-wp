import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { posix } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { FakeSiteConnection } from '@auto-wp/contracts/fakes';

/** Minimal ustar writer/reader: enough for the real verifier (`walkTarGz`) and for rollbacks. */
export function tarGz(entries: Array<[string, Buffer]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of entries) {
    if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.fill(' ', 148, 156);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function untarGz(gz: Buffer): Array<[string, Buffer]> {
  const buf = gunzipSync(gz);
  const out: Array<[string, Buffer]> = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim(), 8);
    out.push([name, Buffer.from(buf.subarray(off + 512, off + 512 + size))]);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Table {
  name: string;
  rows: number;
}

/**
 * An agent-mode (no shell) WordPress simulated on a FakeSiteConnection, plus a local HTTP server for the
 * site's pages, its protected backup folder and a Wordfence-format feed. `autowp-breaker` 2.0.0 "fatals" the
 * homepage until it is rolled back.
 */
export async function fakeWpSite(feed: unknown) {
  const conn = new FakeSiteConnection('it-site', 'agent', {
    shell: false,
    execEnabled: false,
    wpCli: { available: false },
    binaries: {},
    outsideDocrootDir: undefined,
  });
  const root = conn.caps.wpRoot;
  const versions = new Map<string, string>([
    ['core:wordpress', '6.5.2'],
    ['plugin:contact-form-7', '5.7'],
    ['plugin:autowp-breaker', '1.0.0'],
    ['plugin:classic-editor', '1.6.3'],
    ['theme:twentytwentyfour', '1.0'],
  ]);
  const updates = new Map<string, string>([
    ['plugin:contact-form-7', '5.8.4'],
    ['plugin:autowp-breaker', '2.0.0'],
    ['theme:twentytwentyfour', '1.1'],
  ]);
  const fileFor = (key: string) => {
    const [type, slug] = key.split(':') as [string, string];
    return type === 'plugin'
      ? `wp-content/plugins/${slug}/${slug}.php`
      : `wp-content/themes/${slug}/style.css`;
  };
  const writeVersion = (key: string, v: string) => conn.seed({ [fileFor(key)]: `${key} ${v}` });
  conn.seed({
    'wp-config.php': '<?php // secrets',
    'index.php': '<?php // index',
    'wp-includes/version.php': "<?php\n$wp_version = '6.5.2';\n",
    'wp-admin/index.php': '<?php // admin',
  });
  for (const [k, v] of versions) if (k !== 'core:wordpress') writeVersion(k, v);

  let tables: Table[] = [
    { name: 'wp_options', rows: 12 },
    { name: 'wp_posts', rows: 5 },
  ];
  const dump = (t: Table[]) => {
    let sql = '';
    for (const x of t) {
      sql += `CREATE TABLE \`${x.name}\` (id int);\n`;
      if (x.rows)
        sql += `INSERT INTO \`${x.name}\` VALUES ${Array.from({ length: x.rows }, (_, i) => `(${i})`).join(',')};\n`;
    }
    return gzipSync(Buffer.from(`${sql}-- Dump completed 2026-10-24T10:00:00Z\n`));
  };
  const parseDump = (gz: Buffer): Table[] => {
    const sql = gunzipSync(gz).toString();
    return [...sql.matchAll(/CREATE TABLE `([^`]+)`/g)].map((m) => ({
      name: m[1] as string,
      rows: new RegExp(`INSERT INTO \`${m[1]}\` VALUES ([^;]*);`).exec(sql)?.[1]?.split('),(').length ?? 0,
    }));
  };
  const rel = (abs: string) => abs.slice(root.length + 1);
  const excluded = (r: string, excludes: string[]) =>
    excludes.some((e) => {
      if (e.startsWith('*')) return r.endsWith(e.slice(1));
      const p = e.replace(/\*$/, '');
      return r === e || r.startsWith(`${e}/`) || (e.endsWith('*') && r.startsWith(p));
    });
  const treeUnder = (dir: string, excludes: string[], paths?: string[]) => {
    const base = conn.resolve(dir);
    return [...conn.files]
      .filter(([p]) => p.startsWith(`${base}/`))
      .map(([p, d]) => [p.slice(base.length + 1), d] as [string, Buffer])
      .filter(([r]) => !excluded(r, excludes))
      .filter(([r]) => !paths || paths.some((x) => r === x || r.startsWith(`${x}/`)))
      .sort(([a], [b]) => a.localeCompare(b));
  };
  const syncVersionsFromFiles = () => {
    for (const k of versions.keys()) {
      if (k === 'core:wordpress') continue;
      const v = conn.files
        .get(conn.resolve(fileFor(k)))
        ?.toString()
        .split(' ')[1];
      if (v) versions.set(k, v);
    }
  };

  conn
    .onCall('lock.acquire', () => ({ acquired: true }))
    .onCall('lock.release', () => ({ released: true }))
    .onCall('wp.maintenance', (p) => {
      if (p.enabled) conn.seed({ '.maintenance': '<?php $upgrading = time();' });
      else conn.files.delete(conn.resolve('.maintenance'));
      return { enabled: p.enabled };
    })
    .onCall('cache.flush', () => ({ flushed: ['opcache'] }))
    .onCall('fs.count', (p) => {
      const t = treeUnder(p.dir, p.excludes ?? []);
      return { fileCount: t.length, bytes: t.reduce((n, [, d]) => n + d.length, 0) };
    })
    .onCall('db.info', () => ({ server: 'MariaDB', version: '10.11', charset: 'utf8mb4', tables }))
    .onCall('db.dump', (p) => {
      const gz = dump(tables);
      conn.files.set(conn.resolve(p.dest), gz);
      return { tables, bytes: gz.length, sha256: sha256(gz), method: 'native' };
    })
    .onCall('db.import', (p) => {
      tables = parseDump(conn.files.get(conn.resolve(p.source)) ?? Buffer.alloc(0));
      return { statements: tables.length * 2 };
    })
    .onCall('fs.archive', (p) => {
      const t = treeUnder(p.sourceDir, p.excludes ?? [], p.paths);
      const gz = tarGz(t);
      conn.files.set(conn.resolve(p.dest), gz);
      return {
        fileCount: t.length,
        bytes: t.reduce((n, [, d]) => n + d.length, 0),
        archiveBytes: gz.length,
        sha256: sha256(gz),
      };
    })
    .onCall('fs.extract', (p) => {
      const entries = untarGz(conn.files.get(conn.resolve(p.archive)) ?? Buffer.alloc(0));
      const base = conn.resolve(p.destDir);
      for (const [r, d] of entries) conn.files.set(posix.join(base, r), d);
      if (base === root) syncVersionsFromFiles();
      return { fileCount: entries.length, skippedLinks: 0 };
    })
    .onCall('fs.sha256', (p) => {
      const d = conn.files.get(conn.resolve(p.path)) ?? Buffer.alloc(0);
      return { sha256: sha256(d), bytes: d.length };
    })
    .onCall('fs.testArchive', (p) => {
      try {
        return { ok: true, entries: untarGz(conn.files.get(conn.resolve(p.path)) ?? Buffer.alloc(0)).length };
      } catch (e) {
        return { ok: false, entries: 0, error: String(e) };
      }
    })
    .onCall('wp.upgrade', (p) => {
      const key = `${p.type}:${p.slug}`;
      const from = versions.get(key) ?? '';
      const to = p.version ?? updates.get(key) ?? from;
      versions.set(key, to);
      writeVersion(key, to);
      return { fromVersion: from, toVersion: to, messages: [] };
    })
    .onCall('wp.inventory', () => {
      const upd = (k: string) => {
        const v = updates.get(k);
        return v && v !== versions.get(k)
          ? { update: { version: v, package: 'https://downloads.wordpress.org/x.zip' } }
          : {};
      };
      const entries = (type: string) => [...versions].filter(([k]) => k.startsWith(`${type}:`));
      return {
        core: { version: versions.get('core:wordpress') ?? '', locale: 'en_US' },
        plugins: entries('plugin').map(([k, v]) => ({
          slug: k.slice(7),
          file: `${k.slice(7)}/${k.slice(7)}.php`,
          name: k.slice(7),
          version: v,
          active: true,
          networkActive: false,
          requiresPlugins: [],
          ...upd(k),
        })),
        themes: entries('theme').map(([k, v]) => ({
          slug: k.slice(6),
          name: k.slice(6),
          version: v,
          active: true,
          ...upd(k),
        })),
        mustUse: [],
        php: '8.2.0',
        db: '10.11',
      };
    });

  const feedJson = JSON.stringify(feed);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/feed.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(feedJson);
      return;
    }
    if (url.pathname.startsWith('/auto-wp-backup/')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (versions.get('plugin:autowp-breaker') === '2.0.0') {
      res.writeHead(500).end('There has been a critical error on this website.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Hello</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    conn,
    url,
    versions,
    get tables() {
      return tables;
    },
    set tables(t: Table[]) {
      tables = t;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

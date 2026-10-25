import { createHash } from 'node:crypto';
import {
  type ComparisonResult,
  type HealthChecker,
  type HealthSnapshot,
  type ItemResult,
  type Policy,
  PolicySchema,
  type SiteConfig,
  SiteConfigSchema,
  type SiteConnection,
  type UpdateItem,
} from '@auto-wp/contracts';
import { FakeSiteConnection } from '@auto-wp/contracts/fakes';

export const site: SiteConfig = SiteConfigSchema.parse({
  id: 'fake-site',
  name: 'Fake',
  url: 'https://example.com',
  transport: {
    kind: 'agent',
    endpoint: 'https://example.com/auto-wp-agent/agent.php',
    keyId: 'k1',
    signingKeyRef: 'secret:k1',
  },
});

export const baseline: HealthSnapshot = {
  snapshotId: 'base',
  siteId: 'fake-site',
  label: 'before',
  takenAt: '2026-01-01T00:00:00Z',
  pages: [],
  logOffsets: {},
};

export const policy = (p: Partial<Policy> = {}): Policy => PolicySchema.parse(p);

export const item = (
  type: UpdateItem['type'],
  slug: string,
  from: string,
  to: string,
  extra = {},
): UpdateItem => ({
  type,
  slug,
  name: slug,
  currentVersion: from,
  newVersion: to,
  active: true,
  source: 'wporg',
  isMajor: false,
  ...extra,
});

export const OK: ComparisonResult = { ok: true, pages: [], newLogErrors: [] };
export const BAD: ComparisonResult = { ok: false, pages: [], newLogErrors: ['PHP Fatal error'] };

/** Health checker answering from a script of results (or throwing Errors); default ok. */
export class FakeHealth implements HealthChecker {
  readonly calls: Array<{ bypassToken?: string }> = [];
  readonly baselines: HealthSnapshot[] = [];
  constructor(public script: Array<ComparisonResult | Error> = []) {}
  async snapshot(): Promise<HealthSnapshot> {
    return baseline;
  }
  async quick(
    _s: SiteConfig,
    _c: SiteConnection,
    b: HealthSnapshot,
    o?: { bypassToken?: string },
  ): Promise<ComparisonResult> {
    this.calls.push({ bypassToken: o?.bypassToken });
    this.baselines.push(b);
    const next = this.script.shift() ?? OK;
    if (next instanceof Error) throw next;
    return next;
  }
  async compare(): Promise<ComparisonResult> {
    return OK;
  }
}

/** Agent-mode (no shell) fake WordPress with working archive/extract/upgrade simulation. */
export function fakeWp(o: { shell?: boolean } = {}) {
  const conn = new FakeSiteConnection('fake-site', 'agent', {
    shell: o.shell ?? false,
    wpCli: { available: o.shell ?? false, path: 'wp' },
    binaries: {},
  });
  const versions = new Map<string, string>([
    ['core:wordpress', '6.5.0'],
    ['plugin:foo', '1.0.0'],
    ['plugin:bar', '2.0.0'],
    ['theme:twenty', '1.0'],
  ]);
  conn.seed({
    'wp-config.php': '<?php // secrets',
    'index.php': '<?php // index',
    'wp-load.php': '<?php // load',
    'wp-admin/index.php': 'admin 6.5.0',
    'wp-includes/version.php': 'core 6.5.0',
    'wp-content/plugins/foo/foo.php': 'foo 1.0.0',
    'wp-content/plugins/bar/bar.php': 'bar 2.0.0',
    'wp-content/themes/twenty/style.css': 'twenty 1.0',
  });
  const root = conn.caps.wpRoot;
  const rel = (abs: string) => abs.slice(root.length + 1);
  let dbState = 'db-original';
  const state = {
    versions,
    get db() {
      return dbState;
    },
    upgradeFiles: true,
    /** Versions WordPress offers (what `wp plugin update <slug>` installs). */
    offers: new Map<string, string>([
      ['plugin:foo', '1.1.0'],
      ['plugin:bar', '2.1.0'],
      ['theme:twenty', '1.1'],
    ]),
  };

  const archive = (dest: string, paths: string[]) => {
    const entries: Record<string, string> = {};
    for (const [p, d] of conn.files) {
      const r = rel(p);
      if (paths.some((x) => r === x || r.startsWith(`${x}/`))) entries[r] = d.toString('base64');
    }
    conn.files.set(conn.resolve(dest), Buffer.from(JSON.stringify(entries)));
    return Object.keys(entries).length;
  };
  const extract = (archivePath: string, destDir: string) => {
    const entries = JSON.parse(conn.files.get(conn.resolve(archivePath))?.toString() ?? '{}') as Record<
      string,
      string
    >;
    const base = conn.resolve(destDir);
    for (const [r, b64] of Object.entries(entries))
      conn.files.set(`${base}/${r}`, Buffer.from(b64, 'base64'));
    // Re-derive versions from restored files.
    for (const [r] of Object.entries(entries)) {
      const m = /^wp-content\/plugins\/([^/]+)\//.exec(r);
      const content = Buffer.from(entries[r] ?? '', 'base64').toString();
      if (m && base === root) versions.set(`plugin:${m[1]}`, content.split(' ')[1] ?? '');
      if (r === 'wp-includes/version.php' && base === root)
        versions.set('core:wordpress', content.split(' ')[1] ?? '');
      const t = /^wp-content\/themes\/([^/]+)\/style\.css$/.exec(r);
      if (t && base === root) versions.set(`theme:${t[1]}`, content.split(' ')[1] ?? '');
    }
    return Object.keys(entries).length;
  };
  const upgrade = (type: string, slug: string, version: string) => {
    versions.set(`${type}:${slug}`, version);
    if (!state.upgradeFiles) return;
    if (type === 'plugin')
      conn.files.set(`${root}/wp-content/plugins/${slug}/${slug}.php`, Buffer.from(`${slug} ${version}`));
    if (type === 'plugin')
      conn.files.set(`${root}/wp-content/plugins/${slug}/new-file.php`, Buffer.from('new'));
    if (type === 'core') conn.files.set(`${root}/wp-includes/version.php`, Buffer.from(`core ${version}`));
    if (type === 'theme')
      conn.files.set(`${root}/wp-content/themes/${slug}/style.css`, Buffer.from(`${slug} ${version}`));
  };

  conn
    .onCall('lock.acquire', () => ({ acquired: true }))
    .onCall('lock.release', () => ({ released: true }))
    .onCall('wp.maintenance', (p) => ({ enabled: p.enabled }))
    .onCall('cache.flush', () => ({ flushed: ['opcache'] }))
    .onCall('fs.archive', (p) => {
      const n = archive(p.dest, p.paths ?? [p.sourceDir]);
      return { fileCount: n, bytes: n, archiveBytes: n, sha256: '0'.repeat(64) };
    })
    .onCall('fs.extract', (p) => ({ fileCount: extract(p.archive, p.destDir) }))
    .onCall('db.dump', (p) => {
      conn.files.set(conn.resolve(p.dest), Buffer.from(dbState));
      return { tables: [], bytes: dbState.length, sha256: '0'.repeat(64), method: 'native' };
    })
    .onCall('db.import', (p) => {
      dbState = conn.files.get(conn.resolve(p.source))?.toString() ?? '';
      return { statements: 1 };
    })
    .onCall('wp.upgrade', (p) => {
      const from = versions.get(`${p.type}:${p.slug}`) ?? '';
      upgrade(p.type, p.slug, p.version ?? '');
      if (p.type === 'core') dbState = 'db-upgraded';
      return { fromVersion: from, toVersion: p.version ?? '', messages: [] };
    })
    .onCall('wp.inventory', () => ({
      core: { version: versions.get('core:wordpress') ?? '', locale: 'en_US' },
      plugins: [...versions]
        .filter(([k]) => k.startsWith('plugin:'))
        .map(([k, v]) => ({
          slug: k.slice(7),
          file: `${k.slice(7)}/${k.slice(7)}.php`,
          name: k,
          version: v,
          active: true,
          networkActive: false,
          requiresPlugins: [],
        })),
      themes: [...versions]
        .filter(([k]) => k.startsWith('theme:'))
        .map(([k, v]) => ({ slug: k.slice(6), name: k, version: v, active: true })),
      mustUse: [],
      php: '8.2',
      db: '8.0',
    }))
    .onCall('fs.sha256', (p) => {
      const d = conn.files.get(conn.resolve(p.path)) ?? Buffer.alloc(0);
      return { sha256: createHash('sha256').update(d).digest('hex'), bytes: d.length };
    });

  if (o.shell) {
    // Minimal wp-cli + tar emulation on top of the same simulation.
    conn.onExec('wp', (argv) => {
      const a = argv.filter((x) => !x.startsWith('--path=') && !x.startsWith('--skip-'));
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', durationMs: 0 });
      const version = a.find((x) => x.startsWith('--version='))?.slice(10) ?? '';
      if (a[1] === 'core' && a[2] === 'version') return ok(`${versions.get('core:wordpress')}\n`);
      if (a[1] === 'core' && a[2] === 'update') {
        upgrade('core', 'wordpress', version);
        return ok();
      }
      if (a[1] === 'core' && a[2] === 'update-db') {
        dbState = 'db-upgraded';
        return ok();
      }
      if ((a[1] === 'plugin' || a[1] === 'theme') && a[2] === 'update') {
        // Without --version WP-CLI installs the offered package.
        upgrade(a[1], a[3] ?? '', version || (state.offers.get(`${a[1]}:${a[3]}`) ?? ''));
        return ok();
      }
      if ((a[1] === 'plugin' || a[1] === 'theme') && a[2] === 'get')
        return ok(`${versions.get(`${a[1]}:${a[3]}`)}\n`);
      if (a[1] === 'db' && a[2] === 'export') {
        conn.files.set(conn.resolve(a[3] ?? ''), Buffer.from(dbState));
        return ok();
      }
      if (a[1] === 'db' && a[2] === 'import') {
        dbState = conn.files.get(conn.resolve(a[3] ?? ''))?.toString() ?? '';
        return ok();
      }
      if (a[1] === 'db' && a[2] === 'size') return ok('12\n');
      return { exitCode: 1, stdout: '', stderr: `unknown wp ${a.join(' ')}`, durationMs: 0 };
    });
    conn.onExec('tar', (argv) => {
      const ok = { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
      if (argv[1] === '-czf') {
        archive(argv[2] ?? '', argv.slice(argv.indexOf('--') + 1));
        return ok;
      }
      extract(argv[2] ?? '', argv[4] ?? '');
      return ok;
    });
  }
  return { conn, state };
}

export async function collect(it: AsyncIterable<ItemResult>): Promise<ItemResult[]> {
  const out: ItemResult[] = [];
  for await (const r of it) out.push(r);
  return out;
}

export const callOps = (conn: FakeSiteConnection, action: string) =>
  conn.ops.filter((o) => o.op === `call:${action}`);

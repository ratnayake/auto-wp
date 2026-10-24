import type { Capabilities, ExecResult, ItemType, SiteConnection } from '@auto-wp/contracts';
import { absPath } from './paths.js';

/** Thin helpers that pick SSH/WP-CLI execution when available and fall back to agent actions. */
export class Remote {
  constructor(
    readonly c: SiteConnection,
    readonly caps: Capabilities,
  ) {}

  get shell(): boolean {
    return this.caps.shell;
  }

  get wpCli(): boolean {
    return this.caps.shell && this.caps.wpCli.available;
  }

  private bin(name: 'tar' | 'sha256sum'): string {
    return this.caps.binaries[name] ?? name;
  }

  async run(argv: readonly string[], what: string): Promise<ExecResult> {
    const r = await this.c.exec(argv, { cwd: this.caps.wpRoot });
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout).trim().slice(0, 500);
      throw new Error(`${what} failed (exit ${r.exitCode})${detail ? `: ${detail}` : ''}`);
    }
    return r;
  }

  wp(args: readonly string[], what = `wp ${args.slice(0, 2).join(' ')}`): Promise<ExecResult> {
    const wp = this.caps.wpCli.path ?? 'wp';
    return this.run([wp, ...args, `--path=${this.caps.wpRoot}`], what);
  }

  /** tar.gz of `paths` (relative to wpRoot) at `dest`. Written to `<dest>.partial` and renamed when done. */
  async archive(dest: string, paths: string[]): Promise<void> {
    const partial = `${dest}.partial`;
    await this.c.remove(partial).catch(() => undefined);
    if (this.shell) {
      await this.run(
        [this.bin('tar'), '-czf', absPath(this.caps, partial), '-C', this.caps.wpRoot, '--', ...paths],
        'tar create',
      );
    } else {
      const r = await this.c.call('fs.archive', { sourceDir: '.', dest: partial, paths, excludes: [] });
      if (r.fileCount === 0) throw new Error(`fs.archive produced an empty archive for ${paths.join(', ')}`);
    }
    const st = await this.c.stat(partial);
    if (!st || st.type !== 'file' || st.size === 0) throw new Error(`archive ${partial} missing or empty`);
    await this.c.rename(partial, dest);
  }

  async extract(archive: string, destDir: string): Promise<void> {
    if (this.shell) {
      await this.run(
        [this.bin('tar'), '-xzf', absPath(this.caps, archive), '-C', absPath(this.caps, destDir)],
        'tar extract',
      );
    } else {
      await this.c.call('fs.extract', { archive, destDir, overwrite: true });
    }
  }

  /** Returns the file written; WP-CLI writes plain SQL, the agent gzipped SQL. */
  async dbDump(destBase: string): Promise<DbSnapshot> {
    if (this.wpCli) {
      const path = `${destBase}.sql`;
      const partial = `${path}.partial`;
      await this.wp(['db', 'export', absPath(this.caps, partial)], 'wp db export');
      await this.c.rename(partial, path);
      return { path, method: 'wpcli' };
    }
    const path = `${destBase}.sql.gz`;
    const partial = `${path}.partial`;
    await this.c.call('db.dump', { dest: partial, excludeTables: [] });
    await this.c.rename(partial, path);
    return { path, method: 'agent' };
  }

  async dbImport(snap: DbSnapshot): Promise<void> {
    if (snap.method === 'wpcli' && this.wpCli) {
      await this.wp(['db', 'import', absPath(this.caps, snap.path)], 'wp db import');
    } else {
      await this.c.call('db.import', { source: snap.path });
    }
  }

  async sha256(path: string): Promise<string> {
    if (this.shell && this.caps.binaries.sha256sum) {
      const r = await this.run([this.bin('sha256sum'), '--', absPath(this.caps, path)], 'sha256sum');
      const hex = r.stdout.trim().split(/\s+/)[0] ?? '';
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`unexpected sha256sum output for ${path}`);
      return hex;
    }
    return (await this.c.call('fs.sha256', { path })).sha256.toLowerCase();
  }

  async installedVersion(type: ItemType, slug: string): Promise<string | undefined> {
    if (this.wpCli) {
      const args =
        type === 'core'
          ? ['core', 'version']
          : [type, 'get', slug, '--field=version', '--skip-plugins', '--skip-themes'];
      return (await this.wp(args, `wp ${type} version`)).stdout.trim() || undefined;
    }
    const inv = await this.c.call('wp.inventory', { refresh: true });
    if (type === 'core') return inv.core.version;
    const list = type === 'plugin' ? inv.plugins : inv.themes;
    return list.find((p) => p.slug === slug)?.version;
  }

  /** Best-effort DB size in MB; undefined when it cannot be measured. */
  async dbSizeMb(): Promise<number | undefined> {
    if (!this.wpCli) return undefined;
    const r = await this.wp(
      ['db', 'size', '--size_format=mb', '--skip-plugins', '--skip-themes'],
      'wp db size',
    );
    const n = Number.parseFloat(r.stdout.trim());
    return Number.isFinite(n) ? n : undefined;
  }
}

export interface DbSnapshot {
  path: string;
  method: 'wpcli' | 'agent';
}

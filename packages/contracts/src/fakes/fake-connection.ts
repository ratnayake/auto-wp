import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { ActionName, ActionParams, ActionResult } from '../actions.js';
import {
  type CallOptions,
  type Capabilities,
  CapabilityError,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  PathJailError,
  type SiteConnection,
  type TransportKind,
} from '../connection.js';

export type ExecHandler = (
  argv: readonly string[],
  o: ExecOptions | undefined,
  conn: FakeSiteConnection,
) => ExecResult | Promise<ExecResult>;
export type ActionHandler<K extends ActionName> = (
  params: ActionParams[K],
  conn: FakeSiteConnection,
) => ActionResult[K] | Promise<ActionResult[K]>;

export interface RecordedOp {
  op: string;
  args: unknown;
}

export const DEFAULT_FAKE_CAPS: Capabilities = {
  shell: true,
  execEnabled: true,
  phpVersion: '8.2.0',
  phpCli: '/usr/bin/php',
  wpCli: { available: true, path: '/usr/local/bin/wp', version: '2.11.0' },
  binaries: { tar: '/bin/tar', gzip: '/bin/gzip', mysqldump: '/usr/bin/mysqldump', mysql: '/usr/bin/mysql' },
  sodium: true,
  docroot: '/var/www/html',
  wpRoot: '/var/www/html',
  outsideDocrootDir: '/var/www',
  diskFreeBytes: 10 * 1024 ** 3,
};

/**
 * In-memory SiteConnection for unit tests. Files live in a Map keyed by absolute path; directories are
 * implicit (any prefix of a file) or explicit via mkdir. Exec and action behaviour is scripted with
 * `onExec` / `onCall`; `failNext` injects one-shot failures. Every operation is recorded in `ops`.
 */
export class FakeSiteConnection implements SiteConnection {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  readonly ops: RecordedOp[] = [];
  caps: Capabilities;
  closed = false;
  private execHandlers: Array<{ match: (argv: readonly string[]) => boolean; handler: ExecHandler }> = [];
  private actionHandlers = new Map<ActionName, ActionHandler<ActionName>>();
  private failures = new Map<string, Error[]>();

  constructor(
    readonly siteId = 'fake-site',
    readonly kind: TransportKind = 'ssh',
    caps: Partial<Capabilities> = {},
  ) {
    this.caps = { ...DEFAULT_FAKE_CAPS, ...caps };
    this.dirs.add(this.caps.wpRoot);
  }

  // ---- scripting -------------------------------------------------------------------------------

  /** Register an exec handler. `match` may be a binary name (argv[0]) or a predicate. Later wins. */
  onExec(match: string | ((argv: readonly string[]) => boolean), handler: ExecHandler): this {
    const m = typeof match === 'string' ? (argv: readonly string[]) => argv[0] === match : match;
    this.execHandlers.unshift({ match: m, handler });
    return this;
  }

  onCall<K extends ActionName>(action: K, handler: ActionHandler<K>): this {
    this.actionHandlers.set(action, handler as unknown as ActionHandler<ActionName>);
    return this;
  }

  /** Make the next invocation of `op` (e.g. `exec`, `call:wp.upgrade`, `writeFile`) throw `err`. */
  failNext(op: string, err: Error = new Error(`injected failure: ${op}`)): this {
    const list = this.failures.get(op) ?? [];
    list.push(err);
    this.failures.set(op, list);
    return this;
  }

  seed(files: Record<string, string | Buffer>): this {
    for (const [p, d] of Object.entries(files)) {
      this.files.set(this.resolve(p), Buffer.isBuffer(d) ? d : Buffer.from(d));
    }
    return this;
  }

  /** Normalise and jail a path. Public so tests can compute expected keys. */
  resolve(p: string): string {
    const abs = posix.normalize(p.startsWith('/') ? p : posix.join(this.caps.wpRoot, p));
    const roots = [this.caps.wpRoot, this.caps.outsideDocrootDir].filter((r): r is string => !!r);
    if (!roots.some((r) => abs === r || abs.startsWith(`${r}/`)))
      throw new PathJailError(`path outside jail: ${p}`);
    return abs;
  }

  private record(op: string, args: unknown): void {
    this.ops.push({ op, args });
    const pending = this.failures.get(op);
    const err = pending?.shift();
    if (err) throw err;
  }

  // ---- SiteConnection --------------------------------------------------------------------------

  async probe(): Promise<Capabilities> {
    this.record('probe', {});
    return this.caps;
  }

  async exec(argv: readonly string[], o?: ExecOptions): Promise<ExecResult> {
    this.record('exec', { argv: [...argv], cwd: o?.cwd });
    if (!this.caps.shell) throw new CapabilityError('shell not available');
    const h = this.execHandlers.find((e) => e.match(argv));
    if (!h) return { exitCode: 127, stdout: '', stderr: `fake: no handler for ${argv[0]}`, durationMs: 0 };
    return h.handler(argv, o, this);
  }

  async call<K extends ActionName>(
    action: K,
    params: ActionParams[K],
    o?: CallOptions,
  ): Promise<ActionResult[K]> {
    this.record(`call:${action}`, params);
    const h = this.actionHandlers.get(action);
    if (!h) throw new Error(`fake: no handler for action ${action}`);
    o?.onProgress?.({ done: 1, total: 1 });
    return (await h(params as ActionParams[ActionName], this)) as ActionResult[K];
  }

  async readFile(path: string): Promise<Buffer> {
    this.record('readFile', { path });
    const d = this.files.get(this.resolve(path));
    if (!d) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return Buffer.from(d);
  }

  async writeFile(
    path: string,
    data: Buffer | string,
    o?: { mode?: number; atomic?: boolean },
  ): Promise<void> {
    this.record('writeFile', { path, mode: o?.mode, atomic: o?.atomic });
    this.files.set(this.resolve(path), Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data));
  }

  async stat(path: string): Promise<FileStat | null> {
    this.record('stat', { path });
    const abs = this.resolve(path);
    const f = this.files.get(abs);
    if (f) return { path: abs, type: 'file', size: f.length, mode: 0o644, mtimeMs: 0 };
    if (this.isDir(abs)) return { path: abs, type: 'dir', size: 0, mode: 0o755, mtimeMs: 0 };
    return null;
  }

  async list(path: string): Promise<FileStat[]> {
    this.record('list', { path });
    const abs = this.resolve(path);
    const children = new Map<string, FileStat>();
    const prefix = `${abs}/`;
    for (const [p, d] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const [name, ...rest] = p.slice(prefix.length).split('/');
      const child = `${prefix}${name}`;
      children.set(
        child,
        rest.length
          ? { path: child, type: 'dir', size: 0, mode: 0o755, mtimeMs: 0 }
          : { path: child, type: 'file', size: d.length, mode: 0o644, mtimeMs: 0 },
      );
    }
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) {
        children.set(dir, { path: dir, type: 'dir', size: 0, mode: 0o755, mtimeMs: 0 });
      }
    }
    return [...children.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async mkdir(path: string, o?: { recursive?: boolean; mode?: number }): Promise<void> {
    this.record('mkdir', { path, ...o });
    this.dirs.add(this.resolve(path));
  }

  async rename(from: string, to: string): Promise<void> {
    this.record('rename', { from, to });
    const a = this.resolve(from);
    const b = this.resolve(to);
    for (const [p, d] of [...this.files]) {
      if (p === a || p.startsWith(`${a}/`)) {
        this.files.delete(p);
        this.files.set(b + p.slice(a.length), d);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === a || dir.startsWith(`${a}/`)) {
        this.dirs.delete(dir);
        this.dirs.add(b + dir.slice(a.length));
      }
    }
  }

  async remove(path: string, o?: { recursive?: boolean }): Promise<void> {
    this.record('remove', { path, ...o });
    const abs = this.resolve(path);
    for (const p of [...this.files.keys()])
      if (p === abs || (o?.recursive && p.startsWith(`${abs}/`))) this.files.delete(p);
    for (const d of [...this.dirs])
      if (d === abs || (o?.recursive && d.startsWith(`${abs}/`))) this.dirs.delete(d);
  }

  async download(path: string, o?: { offset?: number }): Promise<NodeJS.ReadableStream> {
    this.record('download', { path, ...o });
    const d = this.files.get(this.resolve(path));
    if (!d) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return Readable.from([d.subarray(o?.offset ?? 0)]);
  }

  async close(): Promise<void> {
    this.record('close', {});
    this.closed = true;
  }

  private isDir(abs: string): boolean {
    if (this.dirs.has(abs)) return true;
    for (const p of this.files.keys()) if (p.startsWith(`${abs}/`)) return true;
    return false;
  }
}

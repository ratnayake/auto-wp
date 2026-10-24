import type { Readable } from 'node:stream';
import type { FileStat } from '@auto-wp/contracts';
import type { SFTPWrapper } from 'ssh2';

const S_IFMT = 0o170000;
const SFTP_NO_SUCH_FILE = 2;

export interface RawAttrs {
  mode: number;
  size: number;
  mtime: number;
}

export function isNotFound(e: unknown): boolean {
  const err = e as { code?: unknown; message?: string } | null;
  return (
    err?.code === SFTP_NO_SUCH_FILE || err?.code === 'ENOENT' || /no such file/i.test(err?.message ?? '')
  );
}

export function toFileStat(path: string, a: RawAttrs): FileStat {
  const fmt = a.mode & S_IFMT;
  const type = fmt === 0o100000 ? 'file' : fmt === 0o040000 ? 'dir' : fmt === 0o120000 ? 'symlink' : 'other';
  return { path, type, size: a.size, mode: a.mode & 0o7777, mtimeMs: a.mtime * 1000 };
}

type Cb<T> = (err: Error | null | undefined, v: T) => void;
const call = <T>(fn: (cb: Cb<T>) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

/** Promise wrapper over the callback-style ssh2 SFTP subsystem. All paths are absolute and already jailed. */
export class Sftp {
  constructor(private readonly s: SFTPWrapper) {}

  realpath(p: string): Promise<string> {
    return call<string>((cb) => this.s.realpath(p, cb));
  }
  /** realpath that maps "no such file" to null. */
  async realpathOrNull(p: string): Promise<string | null> {
    try {
      return await this.realpath(p);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async lstat(p: string): Promise<RawAttrs | null> {
    try {
      return await call<RawAttrs>((cb) => this.s.lstat(p, cb as never));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async stat(p: string): Promise<RawAttrs | null> {
    try {
      return await call<RawAttrs>((cb) => this.s.stat(p, cb as never));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async readdir(p: string): Promise<Array<{ filename: string; attrs: RawAttrs }>> {
    return call((cb) => this.s.readdir(p, cb as never));
  }
  mkdir(p: string, mode?: number): Promise<void> {
    return call<void>((cb) => this.s.mkdir(p, mode === undefined ? {} : { mode }, cb as never));
  }
  rmdir(p: string): Promise<void> {
    return call<void>((cb) => this.s.rmdir(p, cb as never));
  }
  unlink(p: string): Promise<void> {
    return call<void>((cb) => this.s.unlink(p, cb as never));
  }
  chmod(p: string, mode: number): Promise<void> {
    return call<void>((cb) => this.s.chmod(p, mode, cb as never));
  }
  readFile(p: string): Promise<Buffer> {
    return call<Buffer>((cb) => this.s.readFile(p, cb as never));
  }
  writeFile(p: string, data: Buffer, mode?: number): Promise<void> {
    return call<void>((cb) => this.s.writeFile(p, data, mode === undefined ? {} : { mode }, cb as never));
  }
  createReadStream(p: string, start: number): Readable {
    return this.s.createReadStream(p, start > 0 ? { start } : {});
  }

  /** Rename replacing the target: POSIX rename extension when offered, else unlink + rename. */
  async rename(from: string, to: string): Promise<void> {
    const ext = (this.s as unknown as { ext_openssh_rename?: (a: string, b: string, cb: Cb<void>) => void })
      .ext_openssh_rename;
    if (typeof ext === 'function') {
      try {
        await call<void>((cb) => ext.call(this.s, from, to, cb));
        return;
      } catch {
        // server lacks the extension; fall through
      }
    }
    try {
      await call<void>((cb) => this.s.rename(from, to, cb as never));
    } catch (e) {
      if (!(await this.lstat(to))) throw e;
      await this.unlink(to);
      await call<void>((cb) => this.s.rename(from, to, cb as never));
    }
  }

  end(): void {
    this.s.end();
  }
}

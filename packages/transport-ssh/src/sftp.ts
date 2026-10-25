import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FileStat } from '@auto-wp/contracts';
import type { SFTPWrapper } from 'ssh2';

const S_IFMT = 0o170000;
const SFTP_NO_SUCH_FILE = 2;
const SFTP_OP_UNSUPPORTED = 8;

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

  /**
   * Rename replacing the target. Uses the POSIX-rename extension when the server offers it (atomic).
   * Otherwise the existing destination is moved aside first and restored if the rename fails, so the
   * destination is never lost.
   */
  async rename(from: string, to: string): Promise<void> {
    const ext = (this.s as unknown as { ext_openssh_rename?: (a: string, b: string, cb: Cb<void>) => void })
      .ext_openssh_rename;
    if (typeof ext === 'function') {
      try {
        await call<void>((cb) => ext.call(this.s, from, to, cb));
        return;
      } catch (e) {
        const err = e as { code?: unknown; message?: string };
        if (!(err.code === SFTP_OP_UNSUPPORTED || /does not support/i.test(err.message ?? ''))) throw e;
      }
    }
    const plain = () => call<void>((cb) => this.s.rename(from, to, cb as never));
    try {
      return await plain();
    } catch (e) {
      const existing = await this.lstat(to);
      if (!existing || toFileStat(to, existing).type === 'dir' || !(await this.lstat(from))) throw e;
      const aside = `${to}.auto-wp-old-${randomBytes(6).toString('hex')}`;
      await call<void>((cb) => this.s.rename(to, aside, cb as never));
      try {
        await plain();
      } catch (e2) {
        await call<void>((cb) => this.s.rename(aside, to, cb as never)).catch(() => undefined);
        throw e2;
      }
      await this.unlink(aside).catch(() => undefined);
    }
  }

  onClose(fn: (err?: Error) => void): void {
    const em = this.s as unknown as { on?: (ev: string, f: (e?: Error) => void) => void };
    em.on?.('error', fn);
    em.on?.('close', () => fn());
  }

  end(): void {
    this.s.end();
  }
}

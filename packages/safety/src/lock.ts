import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@auto-wp/contracts';

export interface LockInfo {
  runId: string;
  pid: number;
  expiresAt: number;
}

const GUARD_STALE_MS = 10_000;

export class LockError extends Error {}

const defaultPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export class FileLock {
  constructor(
    private readonly stateDir: string,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly pidAlive: (pid: number) => boolean = defaultPidAlive,
    private readonly pid: number = process.pid,
  ) {}

  private pathFor(siteId: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(siteId)) throw new LockError(`invalid site id: ${siteId}`);
    return join(this.stateDir, 'locks', `${siteId}.lock`);
  }

  async acquire(siteId: string, runId: string, ttlMs = 30 * 60_000): Promise<void> {
    const path = this.pathFor(siteId);
    await mkdir(join(this.stateDir, 'locks'), { recursive: true });
    const info: LockInfo = { runId, pid: this.pid, expiresAt: this.clock.now().getTime() + ttlMs };
    // Lock files are published with link(), so they appear atomically and fully written.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(info), { flag: 'wx' });
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await this.tryLink(tmp, path)) return;
        const existing = await this.read(path);
        if (existing && !this.isStale(existing)) {
          throw new LockError(`site ${siteId} is locked by run ${existing.runId} (pid ${existing.pid})`);
        }
        if (await this.steal(path, tmp)) return;
      }
      throw new LockError(`could not acquire lock for site ${siteId}`);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  private async tryLink(tmp: string, path: string): Promise<boolean> {
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  /**
   * Removes a stale lock. Serialised through a short-lived guard file and re-checked under the guard, so a
   * slow stealer can never delete a lock another process has just taken.
   */
  private async steal(path: string, tmp: string): Promise<boolean> {
    const guard = `${path}.steal`;
    try {
      await writeFile(guard, String(this.pid), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = await stat(guard).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > GUARD_STALE_MS) await unlink(guard).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 20));
      return false;
    }
    try {
      const existing = await this.read(path);
      if (!existing || this.isStale(existing)) {
        await unlink(path).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
        return await this.tryLink(tmp, path);
      }
      return false;
    } finally {
      await unlink(guard).catch(() => undefined);
    }
  }

  async release(siteId: string, runId: string): Promise<void> {
    const path = this.pathFor(siteId);
    const existing = await this.read(path);
    if (!existing) return;
    if (existing.runId !== runId) throw new LockError(`lock for ${siteId} is owned by run ${existing.runId}`);
    await unlink(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  private isStale(l: LockInfo): boolean {
    return l.expiresAt <= this.clock.now().getTime() || !this.pidAlive(l.pid);
  }

  private async read(path: string): Promise<LockInfo | undefined> {
    try {
      const v = JSON.parse(await readFile(path, 'utf8')) as LockInfo;
      return typeof v.runId === 'string' && typeof v.pid === 'number' && typeof v.expiresAt === 'number'
        ? v
        : undefined;
    } catch {
      return undefined;
    }
  }
}

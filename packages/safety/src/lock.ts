import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@auto-wp/contracts';

export interface LockInfo {
  runId: string;
  pid: number;
  expiresAt: number;
}

export class LockError extends Error {}

const defaultPidAlive = (pid: number): boolean => {
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
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(path, JSON.stringify(info), { flag: 'wx' });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const existing = await this.read(path);
      if (existing && !this.isStale(existing)) {
        throw new LockError(`site ${siteId} is locked by run ${existing.runId} (pid ${existing.pid})`);
      }
      // stale or unreadable: steal
      await unlink(path).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
    throw new LockError(`could not acquire lock for site ${siteId}`);
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

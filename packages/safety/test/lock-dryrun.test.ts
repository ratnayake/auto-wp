import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { DryRunRecorder, FileLock } from '../src/index.js';

const dir = () => mkdtemp(join(tmpdir(), 'lock-'));

describe('FileLock', () => {
  it('refuses contention, then allows after release', async () => {
    const lock = new FileLock(await dir(), new FakeClock(), () => true);
    await lock.acquire('s1', 'r1');
    await expect(lock.acquire('s1', 'r2')).rejects.toThrow(/locked/);
    await lock.acquire('s2', 'r2');
    await lock.release('s1', 'r1');
    await lock.acquire('s1', 'r2');
  });

  it('steals expired locks', async () => {
    const clock = new FakeClock();
    const lock = new FileLock(await dir(), clock, () => true);
    await lock.acquire('s1', 'r1', 1000);
    clock.advance(1000);
    await lock.acquire('s1', 'r2');
    await expect(lock.release('s1', 'r1')).rejects.toThrow(/owned/);
  });

  it('steals locks of dead pids', async () => {
    const d = await dir();
    await new FileLock(d, new FakeClock(), () => true, 4242).acquire('s1', 'r1');
    await new FileLock(d, new FakeClock(), (pid) => pid !== 4242).acquire('s1', 'r2');
  });

  it('refuses release by a non-owner and keeps the lock', async () => {
    const d = await dir();
    const lock = new FileLock(d, new FakeClock(), () => true);
    await lock.acquire('s1', 'r1');
    await expect(lock.release('s1', 'other')).rejects.toThrow(/owned/);
    expect(await readdir(join(d, 'locks'))).toEqual(['s1.lock']);
    await lock.release('s1', 'r1');
    expect(await readdir(join(d, 'locks'))).toEqual([]);
    await lock.release('s1', 'r1');
  });

  it('allows only one winner among concurrent acquirers', async () => {
    const lock = new FileLock(await dir(), new FakeClock(), () => true);
    const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => lock.acquire('s1', `r${i}`)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects path-like site ids', async () => {
    await expect(new FileLock(await dir()).acquire('../x', 'r')).rejects.toThrow(/invalid/);
  });
});

describe('DryRunRecorder', () => {
  it('records in dry-run, executes otherwise', async () => {
    const rec = new DryRunRecorder();
    let ran = 0;
    expect(await rec.wrap(true, 'do a', async () => ++ran)).toBeUndefined();
    expect(ran).toBe(0);
    expect(await rec.wrap(false, 'do b', async () => ++ran)).toBe(1);
    expect(rec.operations).toEqual(['do a']);
  });
});

describe('FileLock races', () => {
  it('lets exactly one of many concurrent stealers win over a stale lock', async () => {
    const d = await dir();
    const clock = new FakeClock();
    await new FileLock(d, clock, () => true).acquire('s1', 'old', 1000);
    clock.advance(5000);
    const lock = new FileLock(d, clock, () => true);
    const r = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => lock.acquire('s1', `r${i}`)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });

  it('never exposes a partial lock file, and steals corrupt ones', async () => {
    const d = await dir();
    const lock = new FileLock(d, new FakeClock(), () => true);
    await writeFile(join(d, 'locks', 's1.lock'), '').catch(async () => {
      await mkdir(join(d, 'locks'), { recursive: true });
      await writeFile(join(d, 'locks', 's1.lock'), '');
    });
    await lock.acquire('s1', 'r1');
    await expect(lock.acquire('s1', 'r2')).rejects.toThrow(/locked/);
  });

  it('treats non-positive pids as dead with the default liveness check', async () => {
    const d = await dir();
    await new FileLock(d, new FakeClock(), () => true, 0).acquire('s1', 'r1');
    await new FileLock(d, new FakeClock()).acquire('s1', 'r2');
  });
});

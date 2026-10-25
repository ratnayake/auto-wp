import { AgentError } from '@auto-wp/contracts';
import { FakeClock, InMemoryRunStore, MemoryLogger } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { DefaultUpdater, defaultNeedsDbSnapshot, randomBypassToken } from '../src/index.js';
import { BAD, baseline, callOps, collect, FakeHealth, fakeWp, item, OK, policy, site } from './harness.js';

const TOKEN = 'T'.repeat(32);

function setup(o: { shell?: boolean; health?: FakeHealth } = {}) {
  const { conn, state } = fakeWp({ shell: o.shell });
  const health = o.health ?? new FakeHealth();
  const runs = new InMemoryRunStore();
  const logger = new MemoryLogger();
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const updater = new DefaultUpdater({
    health,
    runs,
    logger,
    clock,
    randomToken: () => TOKEN,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const opts = { runId: 'run1', baseline, policy: policy() };
  return { conn, state, health, runs, logger, clock, updater, opts, sleeps };
}

const foo = item('plugin', 'foo', '1.0.0', '1.1.0');
const bar = item('plugin', 'bar', '2.0.0', '2.1.0');
const core = item('core', 'wordpress', '6.5.0', '6.5.1');

const maintenanceCalls = (conn: ReturnType<typeof fakeWp>['conn']) =>
  callOps(conn, 'wp.maintenance').map((o) => (o.args as { enabled: boolean }).enabled);

describe('DefaultUpdater', () => {
  it('happy path: snapshots, maintenance, update, verify, flush, health, maintenance off', async () => {
    const t = setup();
    const res = await collect(t.updater.apply(site, t.conn, [foo, bar], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['updated', 'updated']);
    expect(res[0]?.installedVersion).toBe('1.1.0');
    expect(t.state.versions.get('plugin:bar')).toBe('2.1.0');

    const seq = t.conn.ops.map((o) => o.op).filter((o) => o.startsWith('call:') && o !== 'call:logs.tail');
    expect(seq.slice(0, 9)).toEqual([
      'call:lock.acquire',
      'call:fs.archive',
      'call:wp.maintenance',
      'call:db.dump',
      'call:wp.upgrade',
      'call:wp.inventory',
      'call:cache.flush',
      'call:wp.maintenance',
      'call:fs.archive',
    ]);
    expect(seq.at(-1)).toBe('call:lock.release');
    expect(callOps(t.conn, 'fs.archive')[0]?.args).toMatchObject({
      sourceDir: '.',
      dest: 'auto-wp-backup/run1/items/plugin-foo-1.0.0.tar.gz.partial',
      paths: ['wp-content/plugins/foo'],
    });
    expect(t.conn.files.has(t.conn.resolve('auto-wp-backup/run1/items/plugin-foo-1.0.0.tar.gz'))).toBe(true);
    expect(callOps(t.conn, 'wp.maintenance')[0]?.args).toEqual({ enabled: true, bypassToken: TOKEN });
    expect(t.health.calls).toEqual([{ bypassToken: TOKEN }, { bypassToken: TOKEN }]);

    const rec = await t.runs.get('run1');
    expect(rec?.status).toBe('done');
    expect(rec?.finishedAt).toBeDefined();
    expect(rec?.results.map((r) => r.outcome)).toEqual(['updated', 'updated']);
  });

  it('core snapshot archives wp-admin, wp-includes and root php except wp-config.php', async () => {
    const t = setup();
    await collect(t.updater.apply(site, t.conn, [core], t.opts));
    expect(callOps(t.conn, 'fs.archive')[0]?.args).toMatchObject({
      dest: 'auto-wp-backup/run1/items/core-wordpress-6.5.0.tar.gz.partial',
      paths: ['wp-admin', 'wp-includes', 'index.php', 'wp-load.php'],
    });
  });

  it('health failure → rollback → recovered → continues with next item', async () => {
    const t = setup({ health: new FakeHealth([BAD, OK, OK]) });
    const res = await collect(t.updater.apply(site, t.conn, [foo, bar], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['failed-rolled-back', 'updated']);
    expect(t.state.versions.get('plugin:foo')).toBe('1.0.0');
    // New files from the failed version are gone (dir removed before extract).
    expect(t.conn.files.has(t.conn.resolve('wp-content/plugins/foo/new-file.php'))).toBe(false);
    expect(t.conn.files.get(t.conn.resolve('wp-content/plugins/foo/foo.php'))?.toString()).toBe('foo 1.0.0');
    expect(
      t.conn.ops.some(
        (o) => o.op === 'remove' && (o.args as { path: string }).path === 'wp-content/plugins/foo',
      ),
    ).toBe(true);
    expect(callOps(t.conn, 'db.import')).toHaveLength(1);
    expect(res[0]?.operations).toContain(
      'rollback: extract auto-wp-backup/run1/items/plugin-foo-1.0.0.tar.gz',
    );
    expect((await t.runs.get('run1'))?.status).toBe('done');
  });

  it('stopOnFailure stops after a rolled-back failure', async () => {
    const t = setup({ health: new FakeHealth([BAD, OK]) });
    const res = await collect(t.updater.apply(site, t.conn, [foo, bar], { ...t.opts, stopOnFailure: true }));
    expect(res.map((r) => r.outcome)).toEqual(['failed-rolled-back', 'skipped']);
    expect(t.state.versions.get('plugin:bar')).toBe('2.0.0');
    expect((await t.runs.get('run1'))?.status).toBe('aborted');
  });

  it('rollback fails → failed-rollback-failed, needs-restore, stops', async () => {
    const t = setup({ health: new FakeHealth([BAD, BAD, BAD, BAD]) });
    const res = await collect(t.updater.apply(site, t.conn, [foo, bar], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['failed-rollback-failed', 'skipped']);
    expect(t.sleeps).toEqual([2000, 2000]);
    expect(callOps(t.conn, 'wp.upgrade')).toHaveLength(1);
    const rec = await t.runs.get('run1');
    expect(rec?.status).toBe('needs-restore');
    expect(rec?.finishedAt).toBeDefined();
    expect(maintenanceCalls(t.conn)).toEqual([true, false]);
    expect(callOps(t.conn, 'lock.release')).toHaveLength(1);
    // A needs-restore run cannot be resumed.
    await expect(collect(t.updater.apply(site, t.conn, [foo, bar], t.opts))).rejects.toThrow(
      /needs a restore/,
    );
  });

  it('log fatals are judged per item and again after a rollback (log offsets re-baselined)', async () => {
    const t = setup({ health: new FakeHealth([BAD, OK]) });
    let size = 100;
    t.conn.onCall('logs.tail', (p) => {
      if (p.path === 'error_log') throw new Error('log file not found');
      size += 400; // every read sees a log that grew
      return { data: '', nextOffset: 0, size, rotated: false };
    });
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('failed-rolled-back');
    // Item start (before the update), then after the rollback: each sees the log as it was at that moment.
    expect(t.health.baselines[0]?.logOffsets).toEqual({ 'wp-content/debug.log': 500, error_log: 0 });
    expect(t.health.baselines[1]?.logOffsets).toEqual({ 'wp-content/debug.log': 900, error_log: 0 });
  });

  it('falls back to the agent db.dump when wp db export fails', async () => {
    const t = setup({ shell: true, health: new FakeHealth([BAD, OK]) });
    t.conn.onExec(
      (argv) => argv[0] === 'wp' && argv[1] === 'db' && argv[2] === 'export',
      () => ({ exitCode: 1, stdout: '', stderr: 'TLS/SSL error', durationMs: 0 }),
    );
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('failed-rolled-back');
    expect(res[0]?.operations).toContain('snapshot db: wp db export failed, using the agent dump');
    expect(callOps(t.conn, 'db.dump')).toHaveLength(1);
    expect(callOps(t.conn, 'db.import')).toHaveLength(1);
  });

  it('post-rollback health is retried (opcache can serve the broken code for ~2 s)', async () => {
    const t = setup({ health: new FakeHealth([BAD, BAD, new Error('connection reset'), OK]) });
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('failed-rolled-back');
    expect(t.sleeps).toEqual([2000, 2000]);
    expect(t.health.calls).toHaveLength(4);
    expect(res[0]?.operations).toEqual(
      expect.arrayContaining([
        'rollback: health quick: FAILED',
        'rollback: health quick (attempt 2): error: connection reset',
        'rollback: health quick (attempt 3): ok',
      ]),
    );
    expect(t.state.versions.get('plugin:foo')).toBe('1.0.0');
  });

  it('rollback extract failure → needs-restore', async () => {
    const t = setup({ health: new FakeHealth([BAD]) });
    t.conn.failNext('call:fs.extract', new AgentError('internal', 'disk full'));
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('failed-rollback-failed');
    expect(res[0]?.error).toMatch(/disk full/);
  });

  it('exception mid-update → rollback and maintenance still removed', async () => {
    const t = setup();
    t.conn.failNext('call:wp.upgrade', new AgentError('wp_fatal', 'boom'));
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('failed-rolled-back');
    expect(res[0]?.error).toMatch(/boom/);
    expect(maintenanceCalls(t.conn)).toEqual([true, false]);
  });

  it('health checker throwing still turns maintenance off', async () => {
    const t = setup({
      health: new FakeHealth([
        new Error('playwright crashed'),
        new Error('again'),
        new Error('again'),
        new Error('again'),
      ]),
    });
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('failed-rollback-failed');
    expect(maintenanceCalls(t.conn)).toEqual([true, false]);
    expect(callOps(t.conn, 'lock.release')).toHaveLength(1);
  });

  it('maintenance-off failure is logged loudly and stops the run', async () => {
    const t = setup();
    t.conn.onCall('wp.maintenance', (p) => {
      if (!p.enabled) throw new Error('cannot delete .maintenance');
      return { enabled: true };
    });
    const res = await collect(t.updater.apply(site, t.conn, [foo, bar], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['updated', 'skipped']);
    expect(res[0]?.error).toMatch(/maintenance mode could not be disabled/);
    expect(t.logger.lines.some((l) => l.level === 'error' && /MAINTENANCE/.test(l.msg ?? ''))).toBe(true);
    expect((await t.runs.get('run1'))?.status).toBe('aborted');
  });

  it('version mismatch after update counts as failure', async () => {
    const t = setup();
    t.conn.onCall('wp.upgrade', () => ({ fromVersion: '1.0.0', toVersion: '1.0.0', messages: [] }));
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('failed-rolled-back');
    expect(res[0]?.error).toMatch(/installed version 1.0.0 != expected 1.1.0/);
  });

  it('cache flush failure is only a warning', async () => {
    const t = setup();
    t.conn.failNext('call:cache.flush');
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('updated');
    expect(t.logger.lines.some((l) => l.level === 'warn' && l.msg === 'cache flush failed')).toBe(true);
  });

  it('snapshot failure skips the item without touching the site', async () => {
    const t = setup();
    t.conn.failNext('call:fs.archive');
    const res = await collect(t.updater.apply(site, t.conn, [foo, bar], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['skipped', 'updated']);
    expect(callOps(t.conn, 'wp.upgrade')).toHaveLength(1);
  });

  it('crash + resume skips items with a final outcome', async () => {
    const t = setup();
    // State left behind by a process that crashed after finishing foo while working on bar.
    await t.runs.save({
      runId: 'run1',
      siteId: site.id,
      kind: 'update',
      dryRun: false,
      plan: [foo, bar],
      results: [
        {
          item: foo,
          outcome: 'updated',
          installedVersion: '1.1.0',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:00.000Z',
          operations: [],
        },
      ],
      baseline,
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await collect(t.updater.apply(site, t.conn, [foo, bar], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['updated', 'updated']);
    const upgrades = callOps(t.conn, 'wp.upgrade').map((o) => (o.args as { slug: string }).slug);
    expect(upgrades).toEqual(['bar']);
    expect(callOps(t.conn, 'fs.archive')).toHaveLength(1);
    // Stale maintenance from the crash is cleared first.
    expect(callOps(t.conn, 'wp.maintenance')[0]?.args).toEqual({ enabled: false });
    const rec = await t.runs.get('run1');
    expect(rec?.status).toBe('done');
    expect(rec?.results.map((r) => r.outcome)).toEqual(['updated', 'updated']);
  });

  it('resume reuses an existing item snapshot instead of overwriting it', async () => {
    const t = setup();
    t.conn.seed({ 'auto-wp-backup/run1/items/plugin-foo-1.0.0.tar.gz': '{"x":"eQ=="}' });
    const res = await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    expect(res[0]?.outcome).toBe('updated');
    expect(callOps(t.conn, 'fs.archive')).toHaveLength(0);
    expect(res[0]?.operations[0]).toMatch(/reusing/);
  });

  it('resume re-applies the core-failure stop instead of updating the remaining items', async () => {
    const t = setup({ health: new FakeHealth([BAD, OK]) });
    await collect(t.updater.apply(site, t.conn, [core, foo], t.opts));
    const res = await collect(t.updater.apply(site, t.conn, [core, foo], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['failed-rolled-back', 'skipped']);
    expect(callOps(t.conn, 'wp.upgrade')).toHaveLength(1);
    expect((await t.runs.get('run1'))?.status).toBe('aborted');
  });

  it('refuses to resume a run with a different plan', async () => {
    const t = setup();
    await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    await expect(collect(t.updater.apply(site, t.conn, [foo, bar], t.opts))).rejects.toThrow(
      /different plan/,
    );
  });

  it('a lock conflict on resume does not overwrite the stored run record', async () => {
    const t = setup();
    await collect(t.updater.apply(site, t.conn, [foo], t.opts));
    const before = await t.runs.get('run1');
    t.conn.onCall('lock.acquire', () => ({ acquired: false, holder: 'other' }));
    await expect(collect(t.updater.apply(site, t.conn, [foo], t.opts))).rejects.toThrow(/locked/);
    expect(await t.runs.get('run1')).toEqual(before);
  });

  it('held items are yielded untouched', async () => {
    const t = setup();
    const held = item('plugin', 'bar', '2.0.0', '3.0.0', { heldReason: 'policy hold' });
    const res = await collect(t.updater.apply(site, t.conn, [held, foo], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['held', 'updated']);
    expect(t.conn.ops.some((o) => JSON.stringify(o.args).includes('bar'))).toBe(false);
  });

  it('dryRun performs zero mutating operations and lists every step', async () => {
    const t = setup();
    const res = await collect(t.updater.apply(site, t.conn, [foo, core], { ...t.opts, dryRun: true }));
    expect(res.map((r) => r.outcome)).toEqual(['dry-run', 'dry-run']);
    const readOnly = new Set(['probe', 'stat', 'list', 'readFile', 'call:wp.inventory', 'call:db.info']);
    expect(t.conn.ops.filter((o) => !readOnly.has(o.op))).toEqual([]);
    const ops = res[0]?.operations ?? [];
    for (const s of [
      'snapshot files',
      'snapshot db',
      'maintenance on',
      'wp.upgrade',
      'verify',
      'cache flush',
      'health',
      'rollback',
      'maintenance off',
    ])
      expect(ops.some((o) => o.includes(s))).toBe(true);
    expect((await t.runs.get('run1'))?.status).toBe('done');
  });

  it('dryRun with shell also stays read-only', async () => {
    const t = setup({ shell: true });
    await collect(t.updater.apply(site, t.conn, [foo, core], { ...t.opts, dryRun: true }));
    const mutating = t.conn.ops.filter((o) => {
      if (o.op === 'exec') return (o.args as { argv: string[] }).argv.slice(1, 3).join(' ') !== 'db size';
      return !['probe', 'stat', 'list', 'readFile'].includes(o.op);
    });
    expect(mutating).toEqual([]);
  });

  it('core failure always stops the run, even when rolled back', async () => {
    const t = setup({ health: new FakeHealth([BAD, OK]) });
    const res = await collect(t.updater.apply(site, t.conn, [core, foo], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['failed-rolled-back', 'skipped']);
    expect(t.state.versions.get('core:wordpress')).toBe('6.5.0');
    expect(t.state.db).toBe('db-original');
    expect((await t.runs.get('run1'))?.status).toBe('aborted');
  });

  it('lock is released on every path, including an unexpected exception', async () => {
    const t = setup();
    t.runs.save = async () => {
      throw new Error('disk full');
    };
    await expect(collect(t.updater.apply(site, t.conn, [foo], t.opts))).rejects.toThrow('disk full');
    expect(callOps(t.conn, 'lock.release')).toHaveLength(1);
  });

  it('lock is released when the consumer stops iterating early', async () => {
    const t = setup();
    for await (const _ of t.updater.apply(site, t.conn, [foo, bar], t.opts)) break;
    expect(callOps(t.conn, 'lock.release')).toHaveLength(1);
    expect(callOps(t.conn, 'wp.upgrade')).toHaveLength(1);
    expect((await t.runs.get('run1'))?.status).toBe('aborted');
  });

  it('refuses to run when the lock is held elsewhere', async () => {
    const t = setup();
    t.conn.onCall('lock.acquire', () => ({ acquired: false, holder: 'other-run' }));
    await expect(collect(t.updater.apply(site, t.conn, [foo], t.opts))).rejects.toThrow(/other-run/);
    expect(callOps(t.conn, 'wp.upgrade')).toHaveLength(0);
    expect(callOps(t.conn, 'lock.release')).toHaveLength(0);
  });

  it('shell + wp-cli path uses tar and wp commands', async () => {
    const t = setup({ shell: true });
    const res = await collect(t.updater.apply(site, t.conn, [foo, core], t.opts));
    expect(res.map((r) => r.outcome)).toEqual(['updated', 'updated']);
    const argvs = t.conn.ops
      .filter((o) => o.op === 'exec')
      .map((o) => (o.args as { argv: string[] }).argv.filter((a) => !a.startsWith('--path=')).join(' '));
    expect(argvs).toContain('wp plugin update foo');
    expect(argvs).toContain('wp core update --version=6.5.1');
    expect(argvs).toContain('wp core update-db');
    expect(
      argvs.some((a) =>
        a.startsWith('tar -czf /var/www/html/auto-wp-backup/run1/items/plugin-foo-1.0.0.tar.gz.partial'),
      ),
    ).toBe(true);
    expect(argvs.some((a) => a.startsWith('wp db export'))).toBe(true);
    expect(callOps(t.conn, 'wp.upgrade')).toHaveLength(0);
  });

  it('shell rollback uses tar extract and wp db import', async () => {
    const t = setup({ shell: true, health: new FakeHealth([BAD, OK]) });
    const res = await collect(t.updater.apply(site, t.conn, [core], t.opts));
    expect(res[0]?.outcome).toBe('failed-rolled-back');
    expect(t.state.db).toBe('db-original');
    expect(t.state.versions.get('core:wordpress')).toBe('6.5.0');
  });

  it('rejects unsafe slugs', async () => {
    const t = setup();
    const evil = item('plugin', '../../etc', '1', '2');
    const res = await collect(t.updater.apply(site, t.conn, [evil], t.opts));
    expect(res[0]?.outcome).toBe('skipped');
    expect(callOps(t.conn, 'wp.upgrade')).toHaveLength(0);
  });
});

describe('defaultNeedsDbSnapshot', () => {
  it('implements always/never/auto', () => {
    expect(defaultNeedsDbSnapshot(foo, 10_000, policy({ dbSnapshot: 'always' }))).toBe(true);
    expect(defaultNeedsDbSnapshot(core, 1, policy({ dbSnapshot: 'never' }))).toBe(false);
    expect(defaultNeedsDbSnapshot(core, 10_000, policy())).toBe(true);
    expect(defaultNeedsDbSnapshot(item('plugin', 'woocommerce', '1', '2'), 10_000, policy())).toBe(true);
    expect(defaultNeedsDbSnapshot(foo, 10_000, policy())).toBe(false);
    expect(defaultNeedsDbSnapshot(foo, 50, policy())).toBe(true);
    expect(defaultNeedsDbSnapshot(foo, undefined, policy())).toBe(true);
  });

  it('bypass token is 32 url-safe chars', () => {
    expect(randomBypassToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

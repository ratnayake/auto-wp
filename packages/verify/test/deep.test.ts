import { describe, expect, it } from 'vitest';
import type { DockerRunner, DockerRunOptions, DockerRunResult } from '../src/index.js';
import { BACKUP_ID, byName, makeFixture, SITE } from './fixture.js';

class FakeDocker implements DockerRunner {
  readonly calls: string[][] = [];
  imported = '';
  constructor(
    private readonly counts: Record<string, number>,
    private readonly failStage?: string,
  ) {}
  async run(args: readonly string[], o?: DockerRunOptions): Promise<DockerRunResult> {
    this.calls.push([...args]);
    const ok = (stdout = ''): DockerRunResult => ({ exitCode: 0, stdout, stderr: '' });
    const bad: DockerRunResult = { exitCode: 1, stdout: '', stderr: 'boom' };
    if (args[0] === 'run') return this.failStage === 'start' ? bad : ok('cid\n');
    if (args[0] === 'rm') return ok();
    if (args.includes('SELECT 1')) return ok('1');
    if (args.includes('-i')) {
      if (o?.stdin) for await (const c of o.stdin) this.imported += c.toString();
      return this.failStage === 'import' ? bad : ok();
    }
    const sql = args[args.length - 1] ?? '';
    const out = [...sql.matchAll(/SELECT '([^']+)', COUNT/g)].map(
      (m) => `${m[1]}\t${this.counts[m[1] as string] ?? 0}`,
    );
    return ok(out.join('\n'));
  }
}

const GOOD = { wp_posts: 10, wp_options: 7, wp_actionscheduler_logs: 100 };

describe('deep.restore', () => {
  it('imports the decompressed dump and compares counts', async () => {
    const f = await makeFixture();
    const docker = new FakeDocker(GOOD);
    const v = f.make({ dockerRunner: docker, sleep: async () => {} });
    const r = await v.verify(SITE, f.conn, BACKUP_ID, { deep: true });
    expect(byName(r, 'deep.restore')).toMatchObject({ ok: true });
    expect(docker.imported).toContain('CREATE TABLE `wp_posts`');
    expect(docker.calls.at(-1)?.[0]).toBe('rm');
    expect(docker.calls[0]).toContain('mariadb:10.11');
    expect(r.ok).toBe(true);
  });

  it('fails on a non-volatile mismatch, only warns on a volatile one', async () => {
    const f = await makeFixture();
    const hard = await f
      .make({ dockerRunner: new FakeDocker({ ...GOOD, wp_posts: 9 }) })
      .verify(SITE, f.conn, BACKUP_ID, { deep: true });
    expect(byName(hard, 'deep.restore')).toMatchObject({ ok: false, severity: 'error' });
    expect(hard.ok).toBe(false);
    const soft = await f
      .make({ dockerRunner: new FakeDocker({ ...GOOD, wp_actionscheduler_logs: 900 }) })
      .verify(SITE, f.conn, BACKUP_ID, { deep: true });
    expect(byName(soft, 'deep.restore')).toMatchObject({ ok: false, severity: 'warn' });
    expect(soft.ok).toBe(true);
  });

  it.each(['start', 'import'])('reports %s failure and cleans up', async (stage) => {
    const f = await makeFixture();
    const docker = new FakeDocker(GOOD, stage);
    const r = await f
      .make({ dockerRunner: docker, sleep: async () => {} })
      .verify(SITE, f.conn, BACKUP_ID, { deep: true });
    expect(byName(r, 'deep.restore')?.details.stage).toBe(stage);
    expect(r.ok).toBe(false);
    expect(docker.calls.some((c) => c[0] === 'rm')).toBe(stage !== 'start');
  });

  it('is not run unless requested, and skipped without a runner', async () => {
    const f = await makeFixture();
    const docker = new FakeDocker(GOOD);
    await f.make({ dockerRunner: docker }).verify(SITE, f.conn, BACKUP_ID);
    expect(docker.calls).toHaveLength(0);
    const r = await f.verifier.verify(SITE, f.conn, BACKUP_ID, { deep: true });
    expect(byName(r, 'deep.restore')).toMatchObject({ ok: false, severity: 'warn' });
  });
});

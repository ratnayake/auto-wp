import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigSchema, type RunRecord, type SiteConfig } from '@auto-wp/contracts';
import { InMemorySecretStore, MemoryLogger } from '@auto-wp/contracts/fakes';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRunStore } from '../src/run-store.js';
import { createServices, TransportConnectionFactory } from '../src/wire.js';

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'autowp-wire-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const run = (runId: string, siteId = 's1', startedAt = '2026-10-24T10:00:00.000Z'): RunRecord => ({
  runId,
  siteId,
  kind: 'backup',
  dryRun: false,
  plan: [],
  results: [],
  status: 'done',
  startedAt,
});

describe('FileRunStore', () => {
  it('persists runs as JSON files and survives a new instance', async () => {
    const d = await tmp();
    const a = new FileRunStore(d);
    await a.save(run('run-1'));
    await a.save(run('run-2', 's2', '2026-10-24T11:00:00.000Z'));
    await a.save({ ...run('run-1'), status: 'failed', error: 'x' });
    const b = new FileRunStore(d);
    expect((await b.get('run-1'))?.status).toBe('failed');
    expect((await b.list()).map((r) => r.runId)).toEqual(['run-1', 'run-2']);
    expect((await b.list('s2')).map((r) => r.runId)).toEqual(['run-2']);
    expect(await b.get('missing')).toBeUndefined();
  });

  it('rejects unsafe run ids and skips corrupt files', async () => {
    const d = await tmp();
    const s = new FileRunStore(d, new MemoryLogger());
    await expect(s.save(run('../evil'))).rejects.toThrow(/unsafe runId/);
    expect(await s.get('../evil')).toBeUndefined();
    await s.save(run('ok'));
    await writeFile(join(d, 'runs', 'bad.json'), '{not json');
    expect((await s.list()).map((r) => r.runId)).toEqual(['ok']);
  });
});

describe('createServices', () => {
  it('AUTOWP_FAKE=1 forces fakes', async () => {
    const s = await createServices(AppConfigSchema.parse({ sites: [] }), {}, { env: { AUTOWP_FAKE: '1' } });
    expect(s.backup.constructor.name).toBe('StubBackupService');
  });

  it('wires real services without an approval gate unless AUTOWP_TEST_APPROVE=1', async () => {
    const d = await tmp();
    const config = AppConfigSchema.parse({ sites: [], stateDir: d, dataDir: d });
    const env = { AUTOWP_PLAYWRIGHT: '0' };
    const s = await createServices(
      config,
      { logger: new MemoryLogger() },
      { env, secrets: new InMemorySecretStore() },
    );
    expect(s.backup.constructor.name).toBe('DefaultBackupService');
    expect(s.runStore).toBeInstanceOf(FileRunStore);
    expect(['TtyApprovalGate', undefined]).toContain(s.approvalGate?.constructor.name);
  });
});

describe('TransportConnectionFactory', () => {
  const site = (kind: string) => ({ id: 'x', transport: { kind } }) as unknown as SiteConfig;
  it('routes by transport kind and refuses sftp+agent clearly', async () => {
    const opened: string[] = [];
    const f = new TransportConnectionFactory(
      { open: async () => (opened.push('ssh'), {}) as never },
      { open: async () => (opened.push('agent'), {}) as never },
    );
    await f.open(site('ssh'));
    await f.open(site('agent'));
    expect(opened).toEqual(['ssh', 'agent']);
    await expect(f.open(site('sftp+agent'))).rejects.toThrow(/"sftp\+agent" is not supported yet/);
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigSchema } from '@auto-wp/contracts';
import { InMemorySecretStore, MemoryLogger } from '@auto-wp/contracts/fakes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Services } from '../src/container.js';
import { FileRunStore } from '../src/run-store.js';
import { RunManager } from '../src/runs.js';
import { buildServerWithRuns } from '../src/server.js';
import { createServices } from '../src/wire.js';
import { fakeWpSite } from './fake-wp-site.js';

/**
 * The REAL services from createServices() (backup, verify, inventory, vulndb, health, updater, restore,
 * report, file audit log and run store), driven through the MCP server. Only the ConnectionFactory is
 * replaced: it hands out a FakeSiteConnection that simulates an agent-mode WordPress.
 */
describe('integration: real services over a fake site', () => {
  let dir: string;
  let site: Awaited<ReturnType<typeof fakeWpSite>>;
  let services: Services;
  let runs: RunManager;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: any;
    };
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    return r;
  };
  const finish = async (runId: string) => {
    await runs.idle();
    return (await call('run_status', { runId })).structuredContent.run;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autowp-it-'));
    const feed = JSON.parse(
      await readFile(new URL('../../../e2e/fixtures/feeds/wordfence-v3.json', import.meta.url), 'utf8'),
    );
    site = await fakeWpSite(feed);
    const config = AppConfigSchema.parse({
      stateDir: join(dir, 'state'),
      dataDir: join(dir, 'data'),
      vulndb: { wordfenceFeedUrl: `${site.url}/feed.json` },
      sites: [
        {
          id: 'it-site',
          name: 'Integration site',
          url: site.url,
          transport: {
            kind: 'agent',
            endpoint: 'https://it.example/auto-wp-agent/agent.php',
            keyId: 'k1',
            signingKeyRef: 'secret:it-key',
          },
          healthUrls: ['/'],
          logFiles: [],
        },
      ],
    });
    services = await createServices(
      config,
      { connectionFactory: { open: async () => site.conn }, logger: new MemoryLogger() },
      {
        env: { AUTOWP_TEST_APPROVE: '1', AUTOWP_PLAYWRIGHT: '0', AUTOWP_WORDFENCE_MIN_RECORDS: '1' },
        secrets: new InMemorySecretStore(),
      },
    );
    runs = new RunManager(services);
    const { server } = buildServerWithRuns(services, runs);
    client = new Client({ name: 'it', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client?.close();
    await site?.close();
    await rm(dir, { recursive: true, force: true });
  });

  let backupId = '';
  let updateRun = '';

  it('wires the real implementations', () => {
    expect(services.runStore).toBeInstanceOf(FileRunStore);
    expect(services.backup.constructor.name).toBe('DefaultBackupService');
    expect(services.updater.constructor.name).toBe('DefaultUpdater');
    expect(services.approvalGate?.constructor.name).toBe('EnvApprovalGate');
  });

  it('site_probe reports the WordPress version', async () => {
    const r = await call('site_probe', { siteId: 'it-site' });
    expect(r.structuredContent.wpVersion).toBe('6.5.2');
  });

  it('backup_create writes a protected backup and auto-verifies it', async () => {
    const { runId } = (await call('backup_create', { siteId: 'it-site' })).structuredContent;
    const run = await finish(runId);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    backupId = run.backupId;
    const base = `${site.conn.caps.wpRoot}/auto-wp-backup`;
    for (const f of ['manifest.json', 'db.sql.gz', 'files.tar.gz'])
      expect(site.conn.files.has(`${base}/${backupId}/${f}`)).toBe(true);
    for (const f of ['.htaccess', 'index.php', 'web.config'])
      expect(site.conn.files.has(`${base}/${f}`)).toBe(true);
    expect(site.conn.files.has(`${base}/${backupId}/canary.txt`)).toBe(false);
    const list = (await call('backup_list', { siteId: 'it-site' })).structuredContent.backups;
    expect(list).toEqual([expect.objectContaining({ backupId, verified: true })]);
  });

  it('backup_verify passes, and fails for a tampered dump', async () => {
    const ok = (await call('backup_verify', { siteId: 'it-site', backupId })).structuredContent.verification;
    expect(ok.checks.filter((c: any) => !c.ok && c.severity === 'error')).toEqual([]);
    expect(ok.ok).toBe(true);

    const path = `${site.conn.caps.wpRoot}/auto-wp-backup/${backupId}/db.sql.gz`;
    const original = site.conn.files.get(path) as Buffer;
    const tampered = Buffer.from(original);
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;
    site.conn.files.set(path, tampered);
    try {
      const bad = (await call('backup_verify', { siteId: 'it-site', backupId })).structuredContent
        .verification;
      expect(bad.ok).toBe(false);
      expect(bad.checks.find((c: any) => c.name === 'artifact.sha256:db.sql.gz')?.ok).toBe(false);
    } finally {
      site.conn.files.set(path, original);
    }
    // Re-verify so updates_apply sees a passing verification.
    expect(
      (await call('backup_verify', { siteId: 'it-site', backupId })).structuredContent.verification.ok,
    ).toBe(true);
  });

  it('updates_check lists the updates with CVEs from the feed', async () => {
    const r = await call('updates_check', { siteId: 'it-site' });
    const keys = r.structuredContent.items.map((i: any) => `${i.type}:${i.slug}`).sort();
    expect(keys).toEqual(['plugin:autowp-breaker', 'plugin:contact-form-7', 'theme:twentytwentyfour']);
    expect(r.structuredContent.installedCore).toBe('6.5.2');
    expect(r.content[0]?.text).toContain('CVE-2099-0001');
    expect(JSON.stringify(r.structuredContent.assessments)).toContain('CVE-2099-0002');
  });

  it('updates_apply dryRun changes nothing', async () => {
    const before = new Map(site.versions);
    const filesBefore = [...site.conn.files.keys()].filter((p) => !p.includes('/auto-wp-backup/')).sort();
    const { runId } = (await call('updates_apply', { siteId: 'it-site', backupId, dryRun: true }))
      .structuredContent;
    const run = await finish(runId);
    expect(run.status).toBe('done');
    expect(run.results.map((r: any) => r.outcome)).toEqual(['dry-run', 'dry-run', 'dry-run']);
    expect(site.versions).toEqual(before);
    expect([...site.conn.files.keys()].filter((p) => !p.includes('/auto-wp-backup/')).sort()).toEqual(
      filesBefore,
    );
  });

  it('updates_apply updates cf7 + theme and rolls the breaker back', async () => {
    const { runId } = (await call('updates_apply', { siteId: 'it-site', backupId })).structuredContent;
    updateRun = runId;
    const run = await finish(runId);
    const outcome = (slug: string) => run.results.find((r: any) => r.item.slug === slug)?.outcome;
    expect(outcome('contact-form-7')).toBe('updated');
    expect(outcome('twentytwentyfour')).toBe('updated');
    expect(outcome('autowp-breaker')).toBe('failed-rolled-back');
    expect(site.versions.get('plugin:autowp-breaker')).toBe('1.0.0');
    expect(site.conn.files.has(`${site.conn.caps.wpRoot}/.maintenance`)).toBe(false);
    expect(run.status).toBe('done');
    // Durable: the record is on disk under stateDir.
    const onDisk = await new FileRunStore(services.config.stateDir).get(runId);
    expect(onDisk?.results).toHaveLength(3);
  }, 30_000);

  it('report_generate has the three sections, CVEs and the failed breaker', async () => {
    const md = (await call('report_generate', { runId: updateRun, format: 'md' })).content[0]?.text ?? '';
    for (const h of ['## 1. WordPress core', '## 2. Themes', '## 3. Plugins (updated only)'])
      expect(md).toContain(h);
    const plugins = md.split('## 3. Plugins (updated only)')[1]?.split('## Failed')[0] ?? '';
    expect(plugins).toContain('contact-form-7');
    expect(plugins).not.toContain('autowp-breaker');
    expect(plugins).toContain('CVE-2099-0001');
    expect(md.split('## Failed')[1]).toContain('autowp-breaker');
    expect(md).toContain('Wordfence');
  });

  it('restore_plan + restore_execute (approved) restores DB row counts', async () => {
    const manifestTables = site.tables.map((t) => ({ ...t }));
    site.tables = site.tables.map((t) => (t.name === 'wp_posts' ? { ...t, rows: t.rows + 1 } : t));
    const plan = (await call('restore_plan', { siteId: 'it-site', backupId, scope: 'db' })).structuredContent
      .plan;
    const { runId } = (await call('restore_execute', { siteId: 'it-site', planHash: plan.planHash }))
      .structuredContent;
    const run = await finish(runId);
    expect(run.status).toBe('done');
    expect(site.tables).toEqual(manifestTables);
  });

  it('audit log is a non-empty hash chain on disk', async () => {
    const entries = (await call('audit_tail', { limit: 100 })).structuredContent.entries;
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.some((e: any) => e.action === 'approval' && e.data.approved === true)).toBe(true);
    const audit = services.audit as unknown as { verifyChain(): Promise<{ ok: boolean }> };
    expect((await audit.verifyChain()).ok).toBe(true);
  });
});

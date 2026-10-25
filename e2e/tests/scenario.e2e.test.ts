import { TOOL_NAMES, type ToolName } from '@auto-wp/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT,
  dexec,
  E2E_DIR,
  http,
  mcpEnv,
  mustOk,
  ports,
  REAL,
  SSH_CONTAINER,
  sha,
  wp,
} from './helpers.js';

/**
 * Full MCP flow. The MCP server uses FAKE services until integration, so everything here is gated behind
 * AUTOWP_E2E_REAL=1. Output shapes are matched loosely (JSON-stringified containment) on purpose.
 */
let client: Client;
let transport: StdioClientTransport;

async function call(name: ToolName, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
  if (res.structuredContent) return res.structuredContent;
  const text = res.content?.find((c: any) => c.type === 'text')?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitRun(runId: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const s = await call('run_status', { runId });
    if (['done', 'aborted', 'failed', 'needs-restore'].includes(s.status ?? s.run?.status)) return s.run ?? s;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`run ${runId} did not finish`);
}

const PLUGINS = '/var/www/html/wp-content/plugins';
const json = (v: unknown) => JSON.stringify(v);

describe.skipIf(!REAL)('MCP flow: site-ssh', () => {
  const siteId = 'site-ssh';
  let backupId = '';
  let runId = '';
  const rows = () => mustOk(wp('db query "SELECT COUNT(*) FROM wp_posts" --skip-column-names'));

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['-F', '@auto-wp/mcp-server', 'exec', 'tsx', 'src/main.ts', '--stdio'],
      env: mcpEnv(),
      cwd: E2E_DIR,
    });
    client = new Client({ name: 'autowp-e2e', version: '0.0.0' });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client?.close();
  });

  it('exposes every catalogued tool', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of TOOL_NAMES) expect(names).toContain(n);
  });

  it('1. probe', async () => {
    const p = await call('site_probe', { siteId });
    expect(json(p)).toContain('6.5.2');
  });

  it('2. backup_create produces db.sql.gz + files.tar.gz and is not web-readable', async () => {
    const { runId: id } = await call('backup_create', { siteId });
    const run = await waitRun(id);
    expect(run.status).toBe('done');
    backupId = run.backupId;
    const list = await call('backup_list', { siteId });
    expect(json(list)).toContain(backupId);
    const manifest = JSON.parse(
      mustOk(dexec(SSH_CONTAINER, `cat /var/www/html/auto-wp-backup/${backupId}/manifest.json`)),
    );
    const names = manifest.artifacts.map((a: { name: string }) => a.name);
    expect(names).toEqual(expect.arrayContaining(['db.sql.gz', 'files.tar.gz']));
    const web = await http(`http://127.0.0.1:${ports.sshHttp}/auto-wp-backup/${backupId}/manifest.json`);
    expect([403, 404]).toContain(web.status);
  });

  it('3. backup_verify ok; a byte-flipped copy fails', async () => {
    const ok = await call('backup_verify', { siteId, backupId });
    expect(ok.ok).toBe(true);
    const base = '/var/www/html/auto-wp-backup';
    const fake = `${backupId}-corrupt`;
    mustOk(dexec(SSH_CONTAINER, `cp -r ${base}/${backupId} ${base}/${fake}`, 'cpuser'));
    mustOk(
      dexec(
        SSH_CONTAINER,
        `printf '\\xff' | dd of=${base}/${fake}/db.sql.gz bs=1 seek=20 count=1 conv=notrunc`,
        'cpuser',
      ),
    );
    const bad = await call('backup_verify', { siteId, backupId: fake });
    expect(bad.ok).toBe(false);
  });

  it('4. updates_check lists core, cf7, theme and breaker with mock-feed CVEs', async () => {
    const u = json(await call('updates_check', { siteId }));
    for (const s of ['wordpress', 'contact-form-7', 'twentytwentyfour', 'autowp-breaker'])
      expect(u).toContain(s);
    for (const c of ['CVE-2099-0001', 'CVE-2099-0002', 'CVE-2099-0003']) expect(u).toContain(c);
  });

  const only = ['plugin:contact-form-7', 'theme:twentytwentyfour', 'plugin:autowp-breaker'];

  it('5. updates_apply dryRun changes no files', async () => {
    const before = sha(SSH_CONTAINER, PLUGINS);
    const { runId: id } = await call('updates_apply', { siteId, backupId, only, dryRun: true });
    expect((await waitRun(id)).status).toBe('done');
    expect(sha(SSH_CONTAINER, PLUGINS)).toBe(before);
  });

  it('6. real apply: cf7 + theme updated, breaker rolled back', async () => {
    const { runId: id } = await call('updates_apply', { siteId, backupId, only });
    runId = id;
    const run = await waitRun(id);
    const outcome = (slug: string) => run.results.find((r: any) => r.item.slug === slug)?.outcome;
    expect(outcome('contact-form-7')).toBe('updated');
    expect(outcome('twentytwentyfour')).toBe('updated');
    expect(outcome('autowp-breaker')).toBe('failed-rolled-back');
    expect((await http(`http://127.0.0.1:${ports.sshHttp}/`)).status).toBe(200);
    expect(mustOk(wp('plugin get autowp-breaker --field=version'))).toBe('1.0.0');
    expect(dexec(SSH_CONTAINER, 'test -e /var/www/html/.maintenance').status).not.toBe(0);
  });

  it('7. report_generate md has the three sections and lists the breaker as failed', async () => {
    const r = await call('report_generate', { runId, format: 'md' });
    const md: string = typeof r === 'string' ? r : (r.content ?? r.report ?? json(r));
    for (const h of ['## 1. WordPress core', '## 2. Themes', '## 3. Plugins (updated only)'])
      expect(md).toContain(h);
    expect(md).not.toContain('classic-editor');
    expect(md).toContain('autowp-breaker');
  });

  it('8. restore_plan + restore_execute restores the DB row counts', async () => {
    const manifestRows = rows();
    mustOk(wp('post create --post_title=extra --post_status=publish --porcelain'));
    expect(rows()).not.toBe(manifestRows);
    const plan = await call('restore_plan', { siteId, backupId, scope: 'db' });
    const { runId: id } = await call('restore_execute', { siteId, planHash: plan.planHash });
    expect((await waitRun(id)).status).toBe('done');
    expect(rows()).toBe(manifestRows);
  });

  it('9. audit_tail is non-empty', async () => {
    const a = await call('audit_tail', { limit: 20 });
    expect((Array.isArray(a) ? a : (a.entries ?? [])).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!REAL || !AGENT)('MCP flow: site-agent (exec disabled)', () => {
  it('probe works over the signed agent', async () => {
    const c = new Client({ name: 'autowp-e2e-agent', version: '0.0.0' });
    await c.connect(
      new StdioClientTransport({
        command: 'pnpm',
        args: ['-F', '@auto-wp/mcp-server', 'exec', 'tsx', 'src/main.ts', '--stdio'],
        env: mcpEnv(),
        cwd: E2E_DIR,
      }),
    );
    try {
      const res: any = await c.callTool({ name: 'site_probe', arguments: { siteId: 'site-agent' } });
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res)).toContain('6.5.2');
    } finally {
      await c.close();
    }
  });
});

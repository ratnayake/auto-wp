import { TOOL_NAMES, type ToolName } from '@auto-wp/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT,
  DB_CONTAINER,
  dexec,
  E2E_DIR,
  http,
  LOCKED_CONTAINER,
  mcpEnv,
  mustOk,
  ports,
  REAL,
  SSH_CONTAINER,
  sha,
  wp,
} from './helpers.js';

/**
 * Full MCP flow against the real services (gated behind AUTOWP_E2E_REAL=1). `call` returns a tool's
 * structuredContent; `callText` its text content (e.g. a rendered report).
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

async function callText(name: ToolName, args: Record<string, unknown> = {}): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
  return res.content?.find((c: any) => c.type === 'text')?.text ?? '';
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
    const ok = (await call('backup_verify', { siteId, backupId })).verification;
    expect(ok.checks.filter((c: any) => !c.ok && c.severity === 'error')).toEqual([]);
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
    const bad = (await call('backup_verify', { siteId, backupId: fake })).verification;
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
    const md = await callText('report_generate', { runId, format: 'md' });
    for (const h of ['## 1. WordPress core', '## 2. Themes', '## 3. Plugins (updated only)'])
      expect(md).toContain(h);
    expect(md).not.toContain('classic-editor');
    expect(md).toContain('autowp-breaker');
  });

  it('8. restore_plan + restore_execute restores the DB row counts', async () => {
    const manifestRows = rows();
    mustOk(wp('post create --post_title=extra --post_status=publish --porcelain'));
    expect(rows()).not.toBe(manifestRows);
    const { plan } = await call('restore_plan', { siteId, backupId, scope: 'db' });
    const { runId: id } = await call('restore_execute', { siteId, planHash: plan.planHash });
    const run = await waitRun(id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    expect(rows()).toBe(manifestRows);
  });

  it('9. a full restore puts the seeded plugin/theme versions back (and leaves the site as seeded)', async () => {
    const { plan } = await call('restore_plan', { siteId, backupId, scope: 'full' });
    const { runId: id } = await call('restore_execute', { siteId, planHash: plan.planHash });
    const run = await waitRun(id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    expect(mustOk(wp('plugin get contact-form-7 --field=version'))).toBe('5.7');
    expect(mustOk(wp('theme get twentytwentyfour --field=version'))).toBe('1.0');
    expect(dexec(SSH_CONTAINER, 'test -e /var/www/html/.maintenance').status).not.toBe(0);
    // Apache's PHP workers keep realpath() cache entries for files the restore removed (cf7 5.8.4's
    // index.asset.php) for realpath_cache_ttl (120 s); WordPress fatals on them until they expire.
    const deadline = Date.now() + 150_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await http(`http://127.0.0.1:${ports.sshHttp}/`)).status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(status).toBe(200);
  }, 240_000);

  it('10. audit_tail is non-empty', async () => {
    const a = await call('audit_tail', { limit: 20 });
    expect((Array.isArray(a) ? a : (a.entries ?? [])).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!REAL || !AGENT)('MCP flow: site-agent (exec disabled)', () => {
  const siteId = 'site-agent';
  const ROOT = '/var/www/html';
  let backupId = '';
  let runId = '';
  // Read as www-data straight from the DB container: wp-locked has no wp-cli.
  const rows = () =>
    mustOk(dexec(DB_CONTAINER, `mariadb -uroot -proot -N -e "SELECT COUNT(*) FROM wp_locked.wp_posts"`));
  const version = (rel: string) =>
    mustOk(dexec(LOCKED_CONTAINER, `grep -m1 -E '^[ *]*Version:' ${ROOT}/${rel}`)).replace(
      /^.*Version:\s*/,
      '',
    );

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['-F', '@auto-wp/mcp-server', 'exec', 'tsx', 'src/main.ts', '--stdio'],
      env: mcpEnv(),
      cwd: E2E_DIR,
    });
    client = new Client({ name: 'autowp-e2e-agent', version: '0.0.0' });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client?.close();
  });

  it('1. probe works over the signed agent', async () => {
    const p = await call('site_probe', { siteId });
    expect(p.wpVersion).toBe('6.5.2');
    expect(p.capabilities.shell).toBe(false);
    expect(p.capabilities.execEnabled).toBe(false);
  });

  it('2. backup_create (native dump + archive) is protected', async () => {
    const { runId: id } = await call('backup_create', { siteId });
    const run = await waitRun(id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    backupId = run.backupId;
    const manifest = JSON.parse(
      mustOk(dexec(LOCKED_CONTAINER, `cat ${ROOT}/auto-wp-backup/${backupId}/manifest.json`)),
    );
    expect(manifest.method).toEqual({ db: 'native', files: 'native' });
    const web = await http(`http://127.0.0.1:${ports.lockedHttp}/auto-wp-backup/${backupId}/db.sql.gz`);
    expect([403, 404]).toContain(web.status);
  });

  it('3. backup_verify ok', async () => {
    const v = (await call('backup_verify', { siteId, backupId })).verification;
    expect(v.checks.filter((c: any) => !c.ok && c.severity === 'error')).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('4. updates_check shows the mock-feed CVEs', async () => {
    const u = json(await call('updates_check', { siteId }));
    for (const c of ['CVE-2099-0001', 'CVE-2099-0002']) expect(u).toContain(c);
  });

  const only = ['plugin:contact-form-7', 'theme:twentytwentyfour', 'plugin:autowp-breaker'];

  it('5. updates_apply dryRun changes nothing', async () => {
    const before = sha(LOCKED_CONTAINER, `${ROOT}/wp-content/plugins`);
    const { runId: id } = await call('updates_apply', { siteId, backupId, only, dryRun: true });
    expect((await waitRun(id)).status).toBe('done');
    expect(sha(LOCKED_CONTAINER, `${ROOT}/wp-content/plugins`)).toBe(before);
  });

  it('6. real apply via wp.upgrade: cf7 + theme updated, breaker rolled back', async () => {
    const { runId: id } = await call('updates_apply', { siteId, backupId, only });
    runId = id;
    const run = await waitRun(id);
    const outcome = (slug: string) => run.results.find((r: any) => r.item.slug === slug)?.outcome;
    expect(outcome('contact-form-7')).toBe('updated');
    expect(outcome('twentytwentyfour')).toBe('updated');
    expect(outcome('autowp-breaker')).toBe('failed-rolled-back');
    expect(version('wp-content/plugins/autowp-breaker/autowp-breaker.php')).toBe('1.0.0');
    expect((await http(`http://127.0.0.1:${ports.lockedHttp}/`)).status).toBe(200);
    expect(dexec(LOCKED_CONTAINER, `test -e ${ROOT}/.maintenance`).status).not.toBe(0);
  });

  it('7. report sections', async () => {
    const md = await callText('report_generate', { runId, format: 'md' });
    for (const h of ['## 1. WordPress core', '## 2. Themes', '## 3. Plugins (updated only)'])
      expect(md).toContain(h);
    expect(md.split('## Failed')[1]).toContain('autowp-breaker');
  });

  it('8. db restore (approved) restores row counts', async () => {
    const before = rows();
    mustOk(
      dexec(
        DB_CONTAINER,
        `mariadb -uroot -proot -e "INSERT INTO wp_locked.wp_posts (post_title, post_content, post_excerpt, to_ping, pinged, post_content_filtered) VALUES ('extra','','','','','')"`,
      ),
    );
    expect(rows()).not.toBe(before);
    const { plan } = await call('restore_plan', { siteId, backupId, scope: 'db' });
    const { runId: id } = await call('restore_execute', { siteId, planHash: plan.planHash });
    const run = await waitRun(id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    expect(rows()).toBe(before);
  });

  it('9. a full restore over the agent puts the seeded versions back', async () => {
    const { plan } = await call('restore_plan', { siteId, backupId, scope: 'full' });
    const { runId: id } = await call('restore_execute', { siteId, planHash: plan.planHash });
    const run = await waitRun(id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    expect(version('wp-content/plugins/contact-form-7/wp-contact-form-7.php')).toBe('5.7');
    expect(version('wp-content/themes/twentytwentyfour/style.css')).toBe('1.0');
    expect(dexec(LOCKED_CONTAINER, `test -e ${ROOT}/.maintenance`).status).not.toBe(0);
    // See the site-ssh full restore: stale realpath() cache entries can 500 the site for up to 120 s.
    const deadline = Date.now() + 150_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await http(`http://127.0.0.1:${ports.lockedHttp}/`)).status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(status).toBe(200);
    // The agent itself survived the file swap.
    expect((await call('site_probe', { siteId })).wpVersion).toBe('6.5.2');
  }, 240_000);
});

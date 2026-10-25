import { GATED_TOOLS, READ_ONLY_TOOLS, TOOL_NAMES } from '@auto-wp/contracts';
import { StaticApprovalGate } from '@auto-wp/contracts/fakes';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { connect } from './helpers.js';

describe('tool catalogue', () => {
  it('lists exactly TOOL_NAMES with annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.title).toBeTruthy();
      if (READ_ONLY_TOOLS.includes(t.name as never)) {
        expect(t.annotations?.readOnlyHint).toBe(true);
      } else {
        expect(t.annotations?.readOnlyHint).toBe(false);
      }
      if (GATED_TOOLS.includes(t.name as never)) expect(t.annotations?.destructiveHint).toBe(true);
    }
    expect(tools.find((t) => t.name === 'backup_create')?.annotations?.destructiveHint).toBe(false);
    expect(tools.find((t) => t.name === 'updates_apply')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'maintenance_set')?.annotations?.idempotentHint).toBe(true);
  });

  it('exposes the report resource template', async () => {
    const { client } = await connect();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('autowp://runs/{runId}/report.md');
  });

  it('rejects invalid input', async () => {
    const { client } = await connect();
    const bad = await client
      .callTool({ name: 'backup_verify', arguments: { siteId: 'demo' } })
      .catch((e) => e);
    const isErr = bad instanceof Error || (bad as { isError?: boolean }).isError === true;
    expect(isErr).toBe(true);
  });

  it('reports unknown sites as tool errors', async () => {
    const { call } = await connect();
    const r = await call('site_probe', { siteId: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Unknown siteId/);
  });
});

describe('updates and runs', () => {
  it('refuses updates_apply without a verified backup, accepts after backup_create', async () => {
    const { call, waitRun } = await connect();
    const refused = await call('updates_apply', { siteId: 'demo', backupId: 'nonexistent' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/backup_create|backup_verify/);

    const b = await call('backup_create', { siteId: 'demo' });
    const backupRun = await waitRun(b.structuredContent.runId);
    expect(backupRun.status).toBe('done');
    const backupId = backupRun.backupId;

    const u = await call('updates_apply', { siteId: 'demo', backupId });
    expect(u.isError).toBeFalsy();
    const run = await waitRun(u.structuredContent.runId);
    expect(run.status).toBe('done');
    const outcomes = Object.fromEntries(
      run.results.map((r: any) => [`${r.item.type}:${r.item.slug}`, r.outcome]),
    );
    expect(outcomes['plugin:contact-form-7']).toBe('updated');
    expect(outcomes['plugin:broken-plugin']).toBe('failed-rolled-back');
    expect(outcomes['core:wordpress']).toBe('held');
    expect(run.final.ok).toBe(true);
  });

  it('rejects a backup verified outside the policy window', async () => {
    const { call, waitRun, services } = await connect();
    const b = await call('backup_create', { siteId: 'demo' });
    const { backupId } = await waitRun(b.structuredContent.runId);
    services.clock.advance(61 * 60_000);
    const r = await call('updates_apply', { siteId: 'demo', backupId });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/verified .* minutes ago/);
  });

  it('exposes run lifecycle through run_status', async () => {
    const { call, waitRun } = await connect();
    const b = await call('backup_create', { siteId: 'demo' });
    const { runId } = b.structuredContent;
    const first = await call('run_status', { runId });
    expect(['running', 'done']).toContain(first.structuredContent.run.status);
    const done = await waitRun(runId);
    expect(done.kind).toBe('backup');
    const after = await call('run_status', { runId });
    expect(after.structuredContent.recentProgress.length).toBeGreaterThan(0);
    expect((await call('run_status', { runId: 'run-x' })).isError).toBe(true);
  });

  it('honours only and excludes core major unless approved', async () => {
    const { call, waitRun } = await connect({ approvalGate: new StaticApprovalGate(true) });
    const b = await call('backup_create', { siteId: 'demo' });
    const { backupId } = await waitRun(b.structuredContent.runId);
    const u = await call('updates_apply', {
      siteId: 'demo',
      backupId,
      only: ['plugin:akismet', 'core:wordpress'],
      allowCoreMajor: true,
    });
    const run = await waitRun(u.structuredContent.runId);
    const outcomes = Object.fromEntries(
      run.results.map((r: any) => [`${r.item.type}:${r.item.slug}`, r.outcome]),
    );
    expect(outcomes).toEqual({ 'plugin:akismet': 'updated', 'core:wordpress': 'updated' });
  });

  it('keeps core major held when approval is unavailable', async () => {
    const { call, waitRun } = await connect();
    const b = await call('backup_create', { siteId: 'demo' });
    const { backupId } = await waitRun(b.structuredContent.runId);
    const u = await call('updates_apply', {
      siteId: 'demo',
      backupId,
      only: ['core:wordpress'],
      allowCoreMajor: true,
    });
    expect(u.content[0]?.text).toMatch(/Core major update excluded/);
    const run = await waitRun(u.structuredContent.runId);
    expect(run.results[0].outcome).toBe('held');
  });

  it('report lists only updated plugins', async () => {
    const { call, waitRun } = await connect();
    const b = await call('backup_create', { siteId: 'demo' });
    const { backupId } = await waitRun(b.structuredContent.runId);
    const u = await call('updates_apply', {
      siteId: 'demo',
      backupId,
      only: ['plugin:akismet', 'plugin:broken-plugin', 'theme:twentytwentyfour'],
    });
    const { runId } = u.structuredContent;
    await waitRun(runId);
    const r = await call('report_generate', { runId, format: 'json' });
    const report = r.structuredContent.report;
    expect(report.plugins.map((p: any) => p.item.slug)).toEqual(['akismet']);
    expect(report.failed.map((f: any) => f.item.slug)).toEqual(['broken-plugin']);
    expect(report.themes).toHaveLength(1);
    const md = await call('report_generate', { runId });
    expect(md.content[0]?.text).toContain('Akismet');
    expect(md.content[0]?.text).not.toMatch(/Contact Form 7/);
  });

  it('serves the report as a resource', async () => {
    const { call, waitRun, client } = await connect();
    const b = await call('backup_create', { siteId: 'demo' });
    const { backupId } = await waitRun(b.structuredContent.runId);
    const u = await call('updates_apply', { siteId: 'demo', backupId, only: ['plugin:akismet'] });
    const { runId } = u.structuredContent;
    await waitRun(runId);
    const res = await client.readResource({ uri: `autowp://runs/${runId}/report.md` });
    expect((res.contents[0] as { text: string }).text).toContain('Akismet');
  });
});

describe('gating', () => {
  async function plan(
    call: Awaited<ReturnType<typeof connect>>['call'],
    waitRun: (id: string) => Promise<any>,
  ) {
    const b = await call('backup_create', { siteId: 'demo' });
    const { backupId } = await waitRun(b.structuredContent.runId);
    const p = await call('restore_plan', { siteId: 'demo', backupId });
    return p.structuredContent.plan as { planHash: string; steps: string[] };
  }

  it('restore_plan returns hash and steps', async () => {
    const { call, waitRun } = await connect();
    const p = await plan(call, waitRun);
    expect(p.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.steps.length).toBeGreaterThan(0);
  });

  it('refuses restore_execute and backup_prune with no approval path', async () => {
    const { call, waitRun } = await connect();
    const p = await plan(call, waitRun);
    const r = await call('restore_execute', { siteId: 'demo', planHash: p.planHash });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/no approval path/);
    await call('backup_create', { siteId: 'demo' });
    await call('backup_create', { siteId: 'demo' }).then(
      (x) => x.structuredContent && waitRun(x.structuredContent.runId),
    );
    const pr = await call('backup_prune', { siteId: 'demo', keep: 1 });
    expect(pr.isError).toBe(true);
  });

  it('refuses when the gate denies', async () => {
    const { call, waitRun } = await connect({ approvalGate: new StaticApprovalGate(false) });
    const p = await plan(call, waitRun);
    expect((await call('restore_execute', { siteId: 'demo', planHash: p.planHash })).isError).toBe(true);
  });

  it('allows restore_execute and backup_prune with an approving gate', async () => {
    const gate = new StaticApprovalGate(true);
    const { call, waitRun, services } = await connect({ approvalGate: gate });
    const p = await plan(call, waitRun);
    const r = await call('restore_execute', { siteId: 'demo', planHash: p.planHash });
    expect(r.isError).toBeFalsy();
    expect((await waitRun(r.structuredContent.runId)).status).toBe('done');
    expect(gate.requests.map((q) => q.action)).toEqual(['restore.execute']);

    const second = await call('backup_create', { siteId: 'demo' });
    await waitRun(second.structuredContent.runId);
    const dry = await call('backup_prune', { siteId: 'demo', keep: 1, dryRun: true });
    expect(dry.structuredContent.removed).toHaveLength(1);
    const pr = await call('backup_prune', { siteId: 'demo', keep: 1 });
    expect(pr.isError).toBeFalsy();
    expect(pr.structuredContent.removed).toHaveLength(1);
    expect(gate.requests.map((q) => q.action)).toEqual(['restore.execute', 'backup.prune']);
    expect(services.audit.entries.some((e) => e.action === 'approval')).toBe(true);
  });

  it('rejects an unknown planHash', async () => {
    const { call } = await connect({ approvalGate: new StaticApprovalGate(true) });
    expect((await call('restore_execute', { siteId: 'demo', planHash: 'deadbeef' })).isError).toBe(true);
  });

  it('uses elicitation when the client supports it, requiring the hash prefix', async () => {
    let typed = '';
    const gate = new StaticApprovalGate(true);
    const { call, waitRun } = await connect({ approvalGate: gate }, { elicitation: {} }, (c) =>
      c.setRequestHandler(ElicitRequestSchema, async () => ({
        action: 'accept',
        content: { confirm: typed },
      })),
    );
    const p = await plan(call, waitRun);

    typed = 'wrong';
    const bad = await call('restore_execute', { siteId: 'demo', planHash: p.planHash });
    expect(bad.isError).toBe(true);

    typed = p.planHash.slice(0, 8);
    const ok = await call('restore_execute', { siteId: 'demo', planHash: p.planHash });
    expect(ok.isError).toBeFalsy();
    await waitRun(ok.structuredContent.runId);
    expect(gate.requests).toHaveLength(0);
  });
});

describe('audit', () => {
  it('records every tool call without secrets', async () => {
    const { call, services } = await connect();
    await call('sites_list');
    await call('site_probe', { siteId: 'demo' });
    await call('site_probe', { siteId: 'nope' });
    await call('backup_create', { siteId: 'demo', dryRun: true });
    const e = services.audit.entries.filter((x) => x.action.startsWith('tool:'));
    expect(e.map((x) => x.action)).toEqual([
      'tool:sites_list',
      'tool:site_probe',
      'tool:site_probe',
      'tool:backup_create',
    ]);
    expect(e[1]).toMatchObject({ actor: 'test', siteId: 'demo', dryRun: false, data: { outcome: 'ok' } });
    expect(e[2]?.data).toMatchObject({ outcome: 'rejected' });
    expect(e[3]?.dryRun).toBe(true);
    const tail = await call('audit_tail', { limit: 2 });
    expect(tail.structuredContent.entries).toHaveLength(2);
  });
});

describe('policy merge', () => {
  it('effective policy is mergePolicy(app.policy, site.policy): explicit site values win, even default-equal ones', async () => {
    const { runs, services } = await connect();
    const g = services.config;
    g.policy.backupMaxAgeMinutes = 10;
    g.policy.dbSnapshot = 'never';
    const site = g.sites[0]!;
    site.policy = { holds: ['plugin:akismet'], backupMaxAgeMinutes: 60 };
    const p = runs.policy(site);
    expect(p.holds).toEqual(['plugin:akismet']);
    expect(p.backupMaxAgeMinutes).toBe(60);
    expect(p.dbSnapshot).toBe('never');
  });
});

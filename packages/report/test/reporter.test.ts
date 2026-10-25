import { describe, expect, it } from 'vitest';
import { buildReport, DefaultReporter } from '../src/index.js';
import {
  fixtureFailedAndRolledBack,
  fixtureManyVulns,
  fixtureMarkupTitles,
  fixtureMixedPlugins,
  fixtureNothingUpdated,
  fixtureNoVulns,
} from './fixtures.js';

const reporter = new DefaultReporter({ readImage: async () => undefined });

describe('DefaultReporter markdown', () => {
  it('(a) renders a report with no vulnerabilities', async () => {
    const md = await reporter.render(buildReport(fixtureNoVulns()), 'md');
    expect(md).toContain('No known vulnerabilities.');
    expect(md).toMatchSnapshot();
  });

  it('(b) renders many vulnerabilities, flagging those still affecting the new version', async () => {
    const md = await reporter.render(buildReport(fixtureManyVulns()), 'md');
    expect(md).toContain('⚠ no');
    expect(md).toContain('Stored XSS \\| in \\*comments\\* \\[x\\]');
    expect(md).not.toContain('javascript:alert');
    expect(md).toMatchSnapshot();
  });

  it('(c) renders failed core and rolled-back plugins', async () => {
    const md = await reporter.render(buildReport(fixtureFailedAndRolledBack()), 'md');
    expect(md).toContain('Core was not updated.');
    expect(md).toContain('No plugins were updated.');
    expect(md).toMatchSnapshot();
  });

  it('(d) renders the nothing-updated case', async () => {
    const md = await reporter.render(buildReport(fixtureNothingUpdated()), 'md');
    expect(md).toContain('Core was not updated.');
    expect(md).toContain('No themes were updated.');
    expect(md).toContain('No backup was recorded for this run.');
    expect(md).toMatchSnapshot();
  });

  it('(f) section 3 lists only updated plugins', async () => {
    const md = await reporter.render(buildReport(fixtureMixedPlugins()), 'md');
    const section = md.split('## 3. Plugins (updated only)')[1]?.split('## Failed')[0] ?? '';
    expect(section).toContain('Akismet');
    expect(section).not.toContain('Hello Dolly');
    expect(section).not.toContain('Jetpack');
    expect(section).not.toContain('Broken');
    expect(section).not.toContain('Dry');
  });

  it('keeps sections in the required order', async () => {
    const md = await reporter.render(buildReport(fixtureManyVulns()), 'md');
    const headings = md.split('\n').filter((l) => l.startsWith('## ') || l.startsWith('# '));
    expect(headings).toEqual([
      '# Maintenance report — Example Site',
      '## Backup',
      '## 1. WordPress core',
      '## 2. Themes',
      '## 3. Plugins (updated only)',
      '## Failed / rolled back',
      '## Before/after comparison',
      '## Attributions',
    ]);
  });
});

describe('DefaultReporter json', () => {
  it('renders pretty JSON that round-trips to the same report', async () => {
    const report = buildReport(fixtureNoVulns());
    const json = await reporter.render(report, 'json');
    expect(JSON.parse(json)).toEqual(report);
    expect(json).toContain('\n  "generatedAt"');
  });
});

describe('DefaultReporter html', () => {
  it('(e) escapes markup from external titles and names', async () => {
    const html = await reporter.render(buildReport(fixtureMarkupTitles()), 'html');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onmouseover="x"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // javascript: references are not turned into links.
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://ok.example/%22onmouseover=%22x"');
  });

  it('(b) renders the full page with light/dark styles and no external assets', async () => {
    const html = await reporter.render(buildReport(fixtureManyVulns()), 'html');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/<script|<link |src="https?:/);
    expect(html).toContain('⚠ no');
    expect(html).toMatchSnapshot();
  });

  it('embeds diff screenshots as data URIs when readable and under 2 MB', async () => {
    const base = fixtureManyVulns();
    const comparison = {
      ...base.comparison!,
      pages: [
        {
          ...base.comparison!.pages[0]!,
          diffImagePaths: { desktop: '/x/small.png', mobile: '/x/big.png' },
        },
      ],
    };
    const files = new Map<string, Uint8Array>([
      ['/x/small.png', new Uint8Array([137, 80, 78, 71])],
      ['/x/big.png', new Uint8Array(2 * 1024 * 1024)],
    ]);
    const r = new DefaultReporter({ readImage: async (p) => files.get(p) });
    const html = await r.render(buildReport({ ...base, comparison }), 'html');
    expect(html).toContain(
      `src="data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString('base64')}"`,
    );
    expect(html.match(/data:image\/png/g)?.length).toBe(1);
  });

  it('(d) renders the nothing-updated case', async () => {
    const html = await reporter.render(buildReport(fixtureNothingUpdated()), 'html');
    expect(html).toContain('<p>Core was not updated.</p>');
  });
});

describe('DefaultReporter edge cases', () => {
  it('does not report a failed vulnerability lookup as clean', async () => {
    const base = fixtureNoVulns();
    const report = buildReport({
      ...base,
      assessments: [
        { ...base.assessments[0]!, errors: ['wordfence: timeout'], sources: [] },
        ...base.assessments.slice(1),
      ],
    });
    const md = await reporter.render(report, 'md');
    const html = await reporter.render(report, 'html');
    expect(md).toContain('Vulnerability data is incomplete');
    expect(html).toContain('Vulnerability data is incomplete');
  });

  it('never claims "fixed by this update" when the new-version lookup failed', async () => {
    const base = fixtureManyVulns();
    const first = base.assessments.find((a) => a.affectingOld.length > 0)!;
    const assessments = base.assessments.map((a) =>
      a === first ? { ...a, stillAffectingNew: [], lookupFailed: { old: false, new: true } } : a,
    );
    const report = buildReport({ ...base, assessments });
    const md = await reporter.render(report, 'md');
    const html = await reporter.render(report, 'html');
    const section = (s: string) => s.split(first.item.name)[1] ?? '';
    expect(section(md)).toContain('unknown (lookup failed)');
    expect(html).toContain('unknown (lookup failed)');
    const view = (await reporter.render(report, 'md')).split('\n');
    const row = view.find((l) => l.includes(first.affectingOld[0]!.title));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/\| yes \|$/);
  });

  it('says when no backup verification ran', async () => {
    const base = fixtureNoVulns();
    const report = buildReport({ ...base, verification: undefined });
    expect(await reporter.render(report, 'md')).toContain('**Verification:** not run');
    expect(await reporter.render(report, 'html')).toContain('<strong>Verification:</strong> not run');
  });

  it('shows run status and error in the summary', async () => {
    const md = await reporter.render(buildReport(fixtureFailedAndRolledBack()), 'md');
    expect(md).toContain('Run status needs-restore · Run error: rollback incomplete');
  });

  it('uses the first safe http(s) reference when the first one is unsafe', async () => {
    const base = fixtureManyVulns();
    const core = base.assessments[0]!;
    const withBadFirst = {
      ...core,
      affectingOld: [
        {
          id: 'x-1',
          source: 'wordfence' as const,
          title: 'T',
          affected: [],
          references: ['javascript:alert(1)', 'https://wordfence.com/vuln/x-1'],
        },
      ],
      stillAffectingNew: [],
    };
    const md = await reporter.render(buildReport({ ...base, assessments: [withBadFirst] }), 'md');
    expect(md).toContain('[x-1](https://wordfence.com/vuln/x-1)');
  });

  it('lists a duplicated updated result once', async () => {
    const base = fixtureNoVulns();
    const dup = base.run.results.filter((r) => r.item.type === 'plugin');
    const report = buildReport({ ...base, run: { ...base.run, results: [...base.run.results, ...dup] } });
    expect(report.plugins).toHaveLength(1);
  });
});

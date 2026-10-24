import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/index.js';
import {
  assessment,
  baseInput,
  fixtureFailedAndRolledBack,
  fixtureManyVulns,
  fixtureMixedPlugins,
  fixtureNothingUpdated,
  fixtureNoVulns,
  item,
  result,
  runWith,
} from './fixtures.js';

describe('buildReport', () => {
  it('excludes skipped, held, dry-run and failed plugins from section 3 (plugins = updated only)', () => {
    const report = buildReport(fixtureMixedPlugins());
    expect(report.plugins.map((p) => p.item.slug)).toEqual(['akismet']);
    expect(report.failed.map((f) => f.item.slug)).toEqual(['broken']);
    expect(report.failed.map((f) => f.outcome)).toEqual(['failed-rolled-back']);
  });

  it('uses installedVersion as the new version when present', () => {
    const report = buildReport(fixtureNoVulns());
    expect(report.core?.item.newVersion).toBe('6.5.1');
    expect(report.plugins[0]?.item.newVersion).toBe('5.9.3');
  });

  it('includes core only when its outcome is updated', () => {
    expect(buildReport(fixtureFailedAndRolledBack()).core).toBeUndefined();
    expect(buildReport(fixtureNoVulns()).core?.item.slug).toBe('wordpress');
  });

  it('keeps assessment data for updated items and marks missing assessments', () => {
    const core = item('core', 'wordpress', '6.4.2', '6.5.1');
    const report = buildReport(
      baseInput({ run: runWith([result(core, 'updated', { installedVersion: '6.5.1' })]), assessments: [] }),
    );
    expect(report.core?.errors).toEqual(['no vulnerability assessment was available for this item']);
    expect(report.core?.affectingOld).toEqual([]);
    expect(report.core?.item.newVersion).toBe('6.5.1');
  });

  it('matches assessments by item key and ignores non-updated themes', () => {
    const theme = item('theme', 'flavor', '1.0', '1.1');
    const report = buildReport(
      baseInput({
        run: runWith([result(theme, 'skipped')]),
        assessments: [assessment(theme)],
      }),
    );
    expect(report.themes).toEqual([]);
  });

  it('defaults comparison to run.final', () => {
    const base = fixtureNoVulns();
    const final = base.comparison;
    const report = buildReport({ ...base, comparison: undefined, run: { ...base.run, final } });
    expect(report.comparison).toEqual(final);
  });
});

describe('fixtures', () => {
  it('builds every scenario without throwing', () => {
    for (const f of [fixtureNoVulns, fixtureFailedAndRolledBack, fixtureNothingUpdated]) {
      expect(() => buildReport(f())).not.toThrow();
    }
    expect(buildReport(fixtureManyVulns()).core?.affectingOld.length).toBe(3);
  });
});

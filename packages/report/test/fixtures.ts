import type {
  BackupManifest,
  ComparisonResult,
  ItemOutcome,
  ItemResult,
  ItemVulnAssessment,
  UpdateItem,
  VerificationResult,
  Vulnerability,
} from '@auto-wp/contracts';
import type { BuildReportInput } from '../src/index.js';

export const SITE = { id: 'example', name: 'Example Site', url: 'https://example.com' };
export const GENERATED_AT = '2026-10-24T10:30:12.000Z';
export const RUN_ID = '20261024T103012Z-7f3a9c';
const T0 = '2026-10-24T10:30:00.000Z';
const T1 = '2026-10-24T10:31:00.000Z';

export function item(
  type: UpdateItem['type'],
  slug: string,
  currentVersion: string,
  newVersion: string,
  extra: Partial<UpdateItem> = {},
): UpdateItem {
  return {
    type,
    slug,
    name: extra.name ?? (type === 'core' ? 'WordPress' : slug),
    currentVersion,
    newVersion,
    active: true,
    source: 'wporg',
    isMajor: false,
    ...extra,
  };
}

export function result(it: UpdateItem, outcome: ItemOutcome, extra: Partial<ItemResult> = {}): ItemResult {
  return { item: it, outcome, startedAt: T0, finishedAt: T1, operations: [], ...extra };
}

export function vuln(id: string, extra: Partial<Vulnerability> = {}): Vulnerability {
  return {
    id,
    source: 'wordfence',
    title: `Vulnerability ${id}`,
    affected: [{ from: '0', fromInclusive: true, to: '6.5', toInclusive: false }],
    references: [`https://www.wordfence.com/vulnerability/${id}`],
    ...extra,
  };
}

export function assessment(
  it: UpdateItem,
  affectingOld: Vulnerability[] = [],
  stillAffectingNew: Vulnerability[] = [],
  extra: Partial<ItemVulnAssessment> = {},
): ItemVulnAssessment {
  return { item: it, affectingOld, stillAffectingNew, sources: ['wordfence'], errors: [], ...extra };
}

const sha = (c: string) => c.repeat(64);

export function backupManifest(): BackupManifest {
  return {
    schemaVersion: 1,
    backupId: RUN_ID,
    siteId: SITE.id,
    createdAt: T0,
    toolVersion: '0.1.0',
    location: '/var/www/example/auto-wp-backup/' + RUN_ID,
    wp: { core: '6.4.2', php: '8.3.1', db: 'MariaDB 10.11' },
    method: { db: 'wpcli', files: 'tar' },
    db: { tables: [{ name: 'wp_posts', rows: 120 }], charset: 'utf8mb4' },
    files: { count: 3210, bytes: 52428800, excludes: ['wp-content/cache'] },
    artifacts: [
      { name: 'db.sql.gz', bytes: 2048, sha256: sha('a') },
      { name: 'files.tar.gz', bytes: 52428800, sha256: sha('b'), encrypted: false },
    ],
  };
}

export function verificationResult(ok = true): VerificationResult {
  return {
    backupId: RUN_ID,
    ok,
    verifiedAt: T1,
    checks: [
      { name: 'db-gzip-integrity', ok: true, severity: 'error' },
      {
        name: 'files-manifest',
        ok,
        severity: 'error',
        details: ok ? undefined : { missing: ['wp-content/uploads/a.jpg'] },
      },
      { name: 'free-space', ok: true, severity: 'info' },
    ],
  };
}

export function comparison(ok = true): ComparisonResult {
  return {
    ok,
    pages: [
      {
        url: 'https://example.com/',
        statusBefore: 200,
        statusAfter: 200,
        statusChanged: false,
        criticalError: false,
        pixelDiffPct: { desktop: 0.4, mobile: 1.25 },
        diffImagePaths: { desktop: '/tmp/none-desktop.png' },
        newConsoleErrors: [],
        newFailedRequests: [],
        slowdownMs: 0,
        problems: [],
      },
      {
        url: 'https://example.com/shop/',
        statusBefore: 200,
        statusAfter: 500,
        statusChanged: true,
        criticalError: true,
        newConsoleErrors: [],
        newFailedRequests: [],
        slowdownMs: 850,
        problems: ['status 200 -> 500', 'critical error marker found'],
      },
    ],
    newLogErrors: ['PHP Fatal error: Call to undefined function woo_init()'],
  };
}

/** Builds a run with the given results; plan mirrors the results' items. */
export function runWith(results: ItemResult[], opts: { dryRun?: boolean } = {}): BuildReportInput['run'] {
  return {
    runId: RUN_ID,
    siteId: SITE.id,
    kind: 'update',
    dryRun: opts.dryRun ?? false,
    plan: results.map((r) => r.item),
    results,
    status: 'done',
    startedAt: T0,
    finishedAt: T1,
  };
}

export function baseInput(overrides: Partial<BuildReportInput>): BuildReportInput {
  return {
    site: SITE,
    run: runWith([]),
    assessments: [],
    attributions: [],
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

const coreIt = item('core', 'wordpress', '6.4.2', '6.5.1', { name: 'WordPress' });
const themeIt = item('theme', 'twentytwentyfour', '1.1', '1.2', { name: 'Twenty Twenty-Four' });
const pluginIt = item('plugin', 'contact-form-7', '5.8.1', '5.9.3', { name: 'Contact Form 7' });

/** (a) Everything updated, no known vulnerabilities. */
export function fixtureNoVulns(): BuildReportInput {
  const results = [
    result(coreIt, 'updated', { installedVersion: '6.5.1' }),
    result(themeIt, 'updated'),
    result(pluginIt, 'updated', { installedVersion: '5.9.3' }),
  ];
  return baseInput({
    run: runWith(results),
    assessments: [assessment(coreIt), assessment(themeIt), assessment(pluginIt)],
    backup: backupManifest(),
    verification: verificationResult(true),
    comparison: comparison(true),
    attributions: ['Vulnerability data by Wordfence Intelligence'],
  });
}

/** (b) Many vulnerabilities, some of which still affect the new version. */
export function fixtureManyVulns(): BuildReportInput {
  const coreVulns = [
    vuln('core-1', { cve: 'CVE-2024-0001', cvss: { score: 9.8, rating: 'Critical' }, fixedIn: '6.5' }),
    vuln('core-2', {
      cve: 'CVE-2024-0002',
      title: 'Stored XSS | in *comments* [x]',
      cvss: { score: 6.1, rating: 'Medium' },
      fixedIn: '6.5.1',
      affected: [
        { from: '6.4', fromInclusive: true, to: '6.4.3', toInclusive: true },
        { from: '6.5.1', fromInclusive: false, to: '', toInclusive: false },
      ],
    }),
    vuln('core-3', {
      cve: 'CVE-2024-0003',
      title: 'Open redirect',
      cvss: { score: 4.3, rating: 'Medium' },
      references: ['javascript:alert(1)'],
      affected: [{ from: '', fromInclusive: false, to: '6.5.1', toInclusive: false }],
    }),
  ];
  const coreStill = [coreVulns[1] as Vulnerability];
  const pluginVulns = [
    vuln('plug-1', { cve: 'CVE-2024-1111', cvss: { score: 7.5, rating: 'High' }, fixedIn: '5.9.0' }),
    vuln('plug-2', { title: 'SQLi in form export', fixedIn: '5.9.3', cvss: { score: 8.8, rating: 'High' } }),
  ];
  const themeVulns = [vuln('theme-1', { cve: 'CVE-2024-2222', fixedIn: '1.2' })];
  const results = [
    result(coreIt, 'updated', { installedVersion: '6.5.1' }),
    result(themeIt, 'updated'),
    result(pluginIt, 'updated', { installedVersion: '5.9.3' }),
  ];
  return baseInput({
    run: runWith(results),
    assessments: [
      assessment(coreIt, coreVulns, coreStill),
      assessment(themeIt, themeVulns, []),
      assessment(pluginIt, pluginVulns, [pluginVulns[1] as Vulnerability], {
        sources: ['wordfence', 'wpscan'],
        errors: ['wpscan: rate limited'],
      }),
    ],
    backup: backupManifest(),
    verification: verificationResult(false),
    comparison: comparison(false),
    attributions: ['Vulnerability data by Wordfence Intelligence', 'WPScan (https://wpscan.com)'],
  });
}

/** (c) Core update failed and rolled back; plugin updates rolled back too. */
export function fixtureFailedAndRolledBack(): BuildReportInput {
  const plugA = item('plugin', 'woocommerce', '8.0.0', '8.2.0', { name: 'WooCommerce' });
  const plugB = item('plugin', 'yoast', '21.0', '21.5', { name: 'Yoast SEO' });
  const results = [
    result(coreIt, 'failed-rolled-back', { error: 'health check failed: HTTP 500 on /' }),
    result(plugA, 'failed-rolled-back', { error: 'plugin activation fatal' }),
    result(plugB, 'failed-rollback-failed', { error: 'restore of plugin files failed' }),
  ];
  return baseInput({
    run: { ...runWith(results), status: 'needs-restore', error: 'rollback incomplete' },
    assessments: [
      assessment(coreIt, [vuln('core-x', { cve: 'CVE-2024-9999' })]),
      assessment(plugA),
      assessment(plugB),
    ],
    backup: backupManifest(),
    verification: verificationResult(true),
    comparison: comparison(false),
    attributions: [],
  });
}

/** (d) Nothing was updated: all items skipped, held or dry-run. */
export function fixtureNothingUpdated(): BuildReportInput {
  const results = [
    result(coreIt, 'held', { error: 'held by policy: major version' }),
    result(themeIt, 'skipped'),
    result(pluginIt, 'dry-run', { operations: ['wp plugin update contact-form-7'] }),
  ];
  return baseInput({
    run: runWith(results, { dryRun: true }),
    assessments: [assessment(coreIt), assessment(themeIt), assessment(pluginIt)],
    attributions: [],
  });
}

/** (e) Titles and names from external feeds contain markup. */
export function fixtureMarkupTitles(): BuildReportInput {
  const evil = item('plugin', 'evil-plugin', '1.0', '1.1', { name: '<script>alert(1)</script>' });
  const results = [result(evil, 'updated', { installedVersion: '1.1' })];
  return baseInput({
    run: runWith(results),
    assessments: [
      assessment(evil, [
        vuln('evil-1', {
          title: '<script>alert("xss")</script>',
          cve: 'CVE-2024-6666',
          references: ['https://ok.example/"onmouseover="x', 'javascript:alert(2)'],
        }),
      ]),
    ],
    attributions: ['<img src=x onerror=alert(3)>'],
  });
}

/** (f) Mixed outcomes: only `updated` plugins may appear in section 3. */
export function fixtureMixedPlugins(): BuildReportInput {
  const ok = item('plugin', 'akismet', '5.2', '5.3', { name: 'Akismet' });
  const skipped = item('plugin', 'hello-dolly', '1.7', '1.8', { name: 'Hello Dolly' });
  const held = item('plugin', 'jetpack', '13.0', '14.0', { name: 'Jetpack' });
  const failed = item('plugin', 'broken', '2.0', '2.1', { name: 'Broken' });
  const dry = item('plugin', 'dry', '3.0', '3.1', { name: 'Dry' });
  const results = [
    result(ok, 'updated', { installedVersion: '5.3' }),
    result(skipped, 'skipped'),
    result(held, 'held', { error: 'held: major' }),
    result(failed, 'failed-rolled-back', { error: 'boom' }),
    result(dry, 'dry-run'),
  ];
  return baseInput({
    run: runWith(results),
    assessments: [ok, skipped, held, failed, dry].map((i) => assessment(i)),
    attributions: [],
  });
}

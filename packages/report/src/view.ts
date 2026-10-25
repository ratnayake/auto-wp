import type {
  ComparisonResult,
  ItemOutcome,
  ItemVulnAssessment,
  Report,
  Vulnerability,
} from '@auto-wp/contracts';
import { cveUrl, formatBytes, formatCvss, formatPct, formatRange, safeUrl } from './format.js';

/** Format-neutral, unescaped view of a report. Renderers escape everything they print. */
export interface VulnRowView {
  label: string;
  link?: string;
  title: string;
  cvss: string;
  affected: string;
  fixedIn: string;
  fixedByUpdate: boolean;
  stillAffectingNew: boolean;
}

export interface ItemView {
  name: string;
  slug: string;
  change: string;
  rows: VulnRowView[];
  sources: string[];
  errors: string[];
}

export interface ArtifactView {
  name: string;
  size: string;
  sha256: string;
  encrypted: boolean;
}

export interface CheckView {
  name: string;
  severity: string;
  details?: string;
}

export interface BackupView {
  id?: string;
  location?: string;
  artifacts: ArtifactView[];
  verification?: { ok: boolean; verifiedAt: string; total: number; failing: CheckView[] };
}

export interface FailedView {
  item: string;
  error: string;
  outcome: ItemOutcome;
}

export interface PageView {
  url: string;
  status: string;
  statusChanged: boolean;
  pixelDiff: string;
  slowdown: string;
  problems: string;
  /** Diff image paths keyed by device. */
  diffImages: Array<{ device: string; path: string }>;
}

export interface ComparisonView {
  ok: boolean;
  pages: PageView[];
  newLogErrors: string[];
}

export interface ReportView {
  title: string;
  siteUrl: string;
  summary: string;
  generatedAt: string;
  backup?: BackupView;
  core?: ItemView;
  themes: ItemView[];
  plugins: ItemView[];
  failed: FailedView[];
  comparison?: ComparisonView;
  attributions: string[];
}

const ARROW = ' → ';

function vulnRows(a: ItemVulnAssessment): VulnRowView[] {
  const stillIds = new Set(a.stillAffectingNew.map((v) => v.id));
  const seen = new Set<string>();
  const all: Vulnerability[] = [...a.affectingOld, ...a.stillAffectingNew];
  const rows: VulnRowView[] = [];
  for (const v of all) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    rows.push({
      label: v.cve ?? v.id,
      link: v.references.map(safeUrl).find((u) => u !== undefined) ?? (v.cve ? cveUrl(v.cve) : undefined),
      title: v.title,
      cvss: formatCvss(v.cvss),
      affected: v.affected.map(formatRange).join(', ') || 'all versions',
      fixedIn: v.fixedIn ?? '—',
      fixedByUpdate: !stillIds.has(v.id),
      stillAffectingNew: stillIds.has(v.id),
    });
  }
  return rows;
}

function itemView(a: ItemVulnAssessment): ItemView {
  return {
    name: a.item.name,
    slug: a.item.slug,
    change: `${a.item.currentVersion}${ARROW}${a.item.newVersion}`,
    rows: vulnRows(a),
    sources: a.sources,
    errors: a.errors,
  };
}

function backupView(r: Report): BackupView | undefined {
  if (!r.backup && !r.backupVerification) return undefined;
  const v = r.backupVerification;
  return {
    id: r.backup?.backupId ?? v?.backupId,
    location: r.backup?.location,
    artifacts: (r.backup?.artifacts ?? []).map((a) => ({
      name: a.name,
      size: `${formatBytes(a.bytes)} (${a.bytes} bytes)`,
      sha256: a.sha256,
      encrypted: a.encrypted ?? false,
    })),
    verification: v && {
      ok: v.ok,
      verifiedAt: v.verifiedAt,
      total: v.checks.length,
      failing: v.checks
        .filter((c) => !c.ok)
        .map((c) => ({
          name: c.name,
          severity: c.severity,
          details: c.details === undefined ? undefined : truncate(JSON.stringify(c.details), 200),
        })),
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function comparisonView(c: ComparisonResult): ComparisonView {
  return {
    ok: c.ok,
    pages: c.pages.map((p) => {
      const diffs = Object.entries(p.pixelDiffPct ?? {}).map(([d, n]) => `${d} ${formatPct(n)}`);
      return {
        url: p.url,
        status: `${p.statusBefore}${ARROW}${p.statusAfter}`,
        statusChanged: p.statusChanged,
        pixelDiff: diffs.join(', ') || '—',
        slowdown: `${p.slowdownMs} ms`,
        problems: p.problems.join('; ') || 'none',
        diffImages: Object.entries(p.diffImagePaths ?? {}).map(([device, path]) => ({ device, path })),
      };
    }),
    newLogErrors: c.newLogErrors,
  };
}

export function buildView(r: Report): ReportView {
  const counts = countOutcomes(r);
  const summary = [
    `Generated ${r.generatedAt}`,
    `Run ${r.run.runId}`,
    `Dry run: ${r.run.dryRun ? 'yes' : 'no'}`,
    `Updated ${counts.updated}`,
    `Failed ${counts.failed}`,
    `Held ${counts.held}`,
    `Skipped ${counts.skipped}`,
    `Run status ${r.run.status}`,
    ...(r.run.error ? [`Run error: ${r.run.error}`] : []),
  ].join(' · ');
  return {
    title: `Maintenance report — ${r.site.name}`,
    siteUrl: r.site.url,
    summary,
    generatedAt: r.generatedAt,
    backup: backupView(r),
    core: r.core && itemView(r.core),
    themes: r.themes.map(itemView),
    plugins: r.plugins.map(itemView),
    failed: r.failed.map((f) => ({
      item: `${f.item.name} (${f.item.type}:${f.item.slug})`,
      error: f.error ?? '—',
      outcome: f.outcome,
    })),
    comparison: r.comparison && comparisonView(r.comparison),
    attributions: r.attributions,
  };
}

function countOutcomes(r: Report): Record<'updated' | 'failed' | 'held' | 'skipped', number> {
  const count = (pred: (o: ItemOutcome) => boolean) => r.run.results.filter((x) => pred(x.outcome)).length;
  return {
    updated: count((o) => o === 'updated'),
    failed: count((o) => o === 'failed-rolled-back' || o === 'failed-rollback-failed'),
    held: count((o) => o === 'held'),
    skipped: count((o) => o === 'skipped'),
  };
}

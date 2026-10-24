import {
  type BackupManifest,
  type ComparisonResult,
  type ItemResult,
  type ItemVulnAssessment,
  itemKey,
  type Report,
  ReportSchema,
  type RunRecord,
  type VerificationResult,
} from '@auto-wp/contracts';

export interface BuildReportInput {
  site: { id: string; name: string; url: string };
  run: RunRecord;
  /** Vulnerability assessments for the plan items (matched to results by item key). */
  assessments: ItemVulnAssessment[];
  backup?: BackupManifest;
  verification?: VerificationResult;
  /** Defaults to `run.final` when omitted. */
  comparison?: ComparisonResult;
  attributions: string[];
  generatedAt: string;
}

const FAILED_OUTCOMES: ReadonlySet<ItemResult['outcome']> = new Set([
  'failed-rolled-back',
  'failed-rollback-failed',
]);

/** Builds the validated report: only items whose outcome is `updated` appear in sections 1-3. */
export function buildReport(input: BuildReportInput): Report {
  const assessmentByKey = new Map<string, ItemVulnAssessment>();
  for (const a of input.assessments) {
    const key = itemKey(a.item);
    if (!assessmentByKey.has(key)) assessmentByKey.set(key, a);
  }

  // A retried item can leave several results behind; report it once, using the first.
  const seenUpdated = new Set<string>();
  const updatedResults = input.run.results.filter((r) => {
    if (r.outcome !== 'updated' || seenUpdated.has(itemKey(r.item))) return false;
    seenUpdated.add(itemKey(r.item));
    return true;
  });

  const updated: ItemVulnAssessment[] = updatedResults.map((r) => {
    const found = assessmentByKey.get(itemKey(r.item));
    // Installed version wins over the planned one.
    const item = { ...r.item, newVersion: r.installedVersion ?? r.item.newVersion };
    if (found) return { ...found, item };
    return {
      item,
      affectingOld: [],
      stillAffectingNew: [],
      sources: [],
      errors: ['no vulnerability assessment was available for this item'],
    };
  });

  const core = updated.find((a) => a.item.type === 'core');

  const report = {
    generatedAt: input.generatedAt,
    site: { id: input.site.id, name: input.site.name, url: input.site.url },
    run: input.run,
    backup: input.backup,
    backupVerification: input.verification,
    core,
    themes: updated.filter((a) => a.item.type === 'theme'),
    plugins: updated.filter((a) => a.item.type === 'plugin'),
    failed: input.run.results.filter((r) => FAILED_OUTCOMES.has(r.outcome)),
    comparison: input.comparison ?? input.run.final,
    attributions: input.attributions,
  };
  return ReportSchema.parse(report);
}

import {
  type BackupManifest,
  type ComparisonResult,
  type ItemResult,
  type ItemVulnAssessment,
  itemKey,
  type Report,
  type RunRecord,
  type SiteConfig,
  type VerificationResult,
} from '@auto-wp/contracts';

/** Data collected by a run beyond what RunRecord holds; input to report_generate. */
export interface RunExtras {
  backup?: BackupManifest;
  verification?: VerificationResult;
  assessments: ItemVulnAssessment[];
  attributions: string[];
  progress: string[];
  comparison?: ComparisonResult;
}

const isFailed = (r: ItemResult) =>
  r.outcome === 'failed-rolled-back' || r.outcome === 'failed-rollback-failed';

/**
 * Sections: core and themes (unless they failed), plugins only when actually updated, and a failed list.
 * Held/skipped/dry-run plugins are deliberately left out of the plugin section.
 */
export function buildReport(
  run: RunRecord,
  extras: RunExtras,
  site: Pick<SiteConfig, 'id' | 'name' | 'url'>,
  generatedAt: string,
): Report {
  const outcomeOf = new Map(run.results.map((r) => [itemKey(r.item), r]));
  const assessed = (a: ItemVulnAssessment) => outcomeOf.get(itemKey(a.item));
  const notFailed = (a: ItemVulnAssessment) => {
    const r = assessed(a);
    return !r || !isFailed(r);
  };
  return {
    generatedAt,
    site: { id: site.id, name: site.name, url: site.url },
    run,
    backup: extras.backup,
    backupVerification: extras.verification,
    core: extras.assessments.find((a) => a.item.type === 'core' && notFailed(a)),
    themes: extras.assessments.filter((a) => a.item.type === 'theme' && notFailed(a)),
    plugins: extras.assessments.filter((a) => a.item.type === 'plugin' && assessed(a)?.outcome === 'updated'),
    failed: run.results.filter(isFailed),
    comparison: extras.comparison ?? run.final,
    attributions: extras.attributions,
  };
}

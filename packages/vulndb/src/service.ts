import type {
  ItemVulnAssessment,
  Logger,
  UpdateItem,
  Vulnerability,
  VulnProvider,
  VulnService,
} from '@auto-wp/contracts';
import { inAnyRange, versionCompare } from './version.js';

export const WORDFENCE_ATTRIBUTION =
  'Vulnerability data provided by Wordfence Intelligence (https://www.wordfence.com/threat-intel/). ' +
  'Copyright Defiant Inc. Wordfence Intelligence Vulnerability Data Feed is licensed for use under the terms published at https://www.wordfence.com/threat-intel/. ' +
  'Includes CVE(R) identifiers from MITRE: CVE is a registered trademark of The MITRE Corporation (https://www.cve.org/).';
export const WPSCAN_ATTRIBUTION = 'Vulnerability data provided by WPScan (https://wpscan.com/).';
const ATTRIBUTIONS: Record<VulnProvider['name'], string | undefined> = {
  wordfence: WORDFENCE_ATTRIBUTION,
  wpscan: WPSCAN_ATTRIBUTION,
  patchstack: undefined,
};

const normTitle = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const rangesSig = (v: Vulnerability): string =>
  v.affected
    .map((r) => JSON.stringify([r.from, r.fromInclusive, r.to, r.toInclusive]))
    .sort()
    .join('|');

/**
 * Merges duplicates of ONE item's vulnerabilities (so type+slug are implicitly equal): same CVE always
 * merges (ranges unioned, worst CVSS and highest fixedIn kept); without a CVE only an identical
 * normalised title AND identical affected ranges merge, since generic titles recur across distinct bugs.
 */
export function dedupe(vulns: Vulnerability[]): Vulnerability[] {
  const byKey = new Map<string, Vulnerability>();
  for (const v of vulns) {
    const key = v.cve ? `cve:${v.cve.toUpperCase()}` : `title:${normTitle(v.title)}:${rangesSig(v)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...v, affected: [...v.affected], references: [...v.references] });
      continue;
    }
    const seen = new Set(prev.affected.map((r) => JSON.stringify(r)));
    for (const r of v.affected) if (!seen.has(JSON.stringify(r))) prev.affected.push(r);
    for (const ref of v.references) if (!prev.references.includes(ref)) prev.references.push(ref);
    if (v.cvss && (!prev.cvss || v.cvss.score > prev.cvss.score)) prev.cvss = v.cvss;
    if (v.fixedIn && (!prev.fixedIn || versionCompare(v.fixedIn, prev.fixedIn) > 0)) prev.fixedIn = v.fixedIn;
  }
  return [...byKey.values()];
}

export class DefaultVulnService implements VulnService {
  private readonly used = new Set<VulnProvider['name']>();

  /** `providers` are in priority order: first is primary, the rest are fallbacks. */
  constructor(
    private readonly providers: VulnProvider[],
    private readonly logger?: Logger,
  ) {}

  async assess(items: UpdateItem[]): Promise<ItemVulnAssessment[]> {
    return Promise.all(items.map((item) => this.assessItem(item)));
  }

  private async assessItem(item: UpdateItem): Promise<ItemVulnAssessment> {
    const errors: string[] = [];
    const sources: string[] = [];
    let vulns: Vulnerability[] = [];
    for (const p of this.providers) {
      try {
        const hint = { versions: [item.currentVersion, item.newVersion] };
        vulns = await p.lookup(item.type, item.slug, hint);
        sources.push(p.name);
        const notice = (p as { staleNotice?: () => string | undefined }).staleNotice?.();
        if (notice) errors.push(`${p.name}: ${notice}`);
        this.used.add(p.name);
        break; // an empty result is an answer; only errors fall through to the next provider
      } catch (err) {
        const msg = `${p.name}: ${(err as Error).message}`;
        errors.push(msg);
        this.logger?.warn({ provider: p.name, item: `${item.type}:${item.slug}` }, 'vuln lookup failed');
      }
    }
    const merged = dedupe(vulns);
    return {
      item,
      affectingOld: merged.filter((v) => inAnyRange(item.currentVersion, v.affected)),
      stillAffectingNew: merged.filter((v) => inAnyRange(item.newVersion, v.affected)),
      sources,
      errors,
      lookupFailed: { old: sources.length === 0, new: sources.length === 0 },
    };
  }

  attributions(): string[] {
    return this.providers.filter((p) => this.used.has(p.name)).flatMap((p) => ATTRIBUTIONS[p.name] ?? []);
  }
}

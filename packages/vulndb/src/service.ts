import type {
  ItemVulnAssessment,
  Logger,
  UpdateItem,
  Vulnerability,
  VulnProvider,
  VulnService,
} from '@auto-wp/contracts';
import { inAnyRange } from './version.js';

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

type HintedProvider = VulnProvider & {
  lookup(type: UpdateItem['type'], slug: string, hint?: { versions?: string[] }): Promise<Vulnerability[]>;
};

const normTitle = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Merges duplicates (same CVE, else same normalised title), unioning their affected ranges. */
export function dedupe(vulns: Vulnerability[]): Vulnerability[] {
  const byKey = new Map<string, Vulnerability>();
  for (const v of vulns) {
    const key = v.cve ? `cve:${v.cve.toUpperCase()}` : `title:${normTitle(v.title)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...v, affected: [...v.affected], references: [...v.references] });
      continue;
    }
    const seen = new Set(prev.affected.map((r) => JSON.stringify(r)));
    for (const r of v.affected) if (!seen.has(JSON.stringify(r))) prev.affected.push(r);
    for (const ref of v.references) if (!prev.references.includes(ref)) prev.references.push(ref);
    prev.cvss ??= v.cvss;
    prev.fixedIn ??= v.fixedIn;
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
        vulns = await (p as HintedProvider).lookup(item.type, item.slug, hint);
        sources.push(p.name);
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
    };
  }

  attributions(): string[] {
    return this.providers.filter((p) => this.used.has(p.name)).flatMap((p) => ATTRIBUTIONS[p.name] ?? []);
  }
}

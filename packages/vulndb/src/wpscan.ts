import { join } from 'node:path';
import type { Clock, ItemType, Logger, VersionRange, Vulnerability, VulnProvider } from '@auto-wp/contracts';
import { QuotaExceededError } from './errors.js';
import { DAY_MS, type Fetch, readJson, writeJsonAtomic } from './util.js';

export const DEFAULT_WPSCAN_BASE_URL = 'https://wpscan.com/api/v3';

export interface WpscanOptions {
  token: string;
  cacheDir: string;
  clock: Clock;
  logger?: Logger;
  baseUrl?: string;
  fetch?: Fetch;
  /** Free tier is about 25 requests/day. */
  dailyLimit?: number;
  cacheMs?: number;
}

interface WpscanVuln {
  id?: string | number;
  title?: string;
  fixed_in?: string | null;
  references?: { cve?: string[]; url?: string[] };
  cvss?: { score?: string | number; severity?: string; vector?: string } | null;
}

interface CacheEntry {
  fetchedAt: string;
  vulns: Vulnerability[];
}
interface Quota {
  day: string;
  used: number;
}

const ALL: VersionRange = { from: '*', fromInclusive: true, to: '*', toInclusive: true };

export function mapWpscanVuln(v: WpscanVuln): Vulnerability | undefined {
  if (!v.title) return undefined;
  const cveRaw = v.references?.cve?.[0];
  const score = v.cvss?.score === undefined ? Number.NaN : Number(v.cvss.score);
  const fixed = v.fixed_in || undefined;
  return {
    id: `wpscan-${v.id ?? v.title}`,
    source: 'wpscan',
    ...(cveRaw ? { cve: /^CVE-/i.test(cveRaw) ? cveRaw.toUpperCase() : `CVE-${cveRaw}` } : {}),
    title: v.title,
    ...(Number.isFinite(score)
      ? {
          cvss: {
            score,
            rating: v.cvss?.severity ?? '',
            ...(v.cvss?.vector ? { vector: v.cvss.vector } : {}),
          },
        }
      : {}),
    affected: fixed ? [{ from: '*', fromInclusive: true, to: fixed, toInclusive: false }] : [ALL],
    ...(fixed ? { fixedIn: fixed } : {}),
    references: v.references?.url ?? [],
  };
}

export class WpscanProvider implements VulnProvider {
  readonly name = 'wpscan' as const;
  private readonly base: string;
  private readonly fetchImpl: Fetch;
  private readonly limit: number;
  private readonly cacheMs: number;
  private readonly cachePath: string;
  private readonly quotaPath: string;
  private cache?: Record<string, CacheEntry>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: WpscanOptions) {
    this.base = (opts.baseUrl ?? DEFAULT_WPSCAN_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.limit = opts.dailyLimit ?? 25;
    this.cacheMs = opts.cacheMs ?? DAY_MS;
    this.cachePath = join(opts.cacheDir, 'wpscan-cache.json');
    this.quotaPath = join(opts.cacheDir, 'wpscan-quota.json');
  }

  /**
   * Core lookups are per version in WPScan; callers pass the versions of interest via `hint`
   * (without it core cannot be looked up and an error is thrown).
   */
  lookup(type: ItemType, slug: string, hint?: { versions?: string[] }): Promise<Vulnerability[]> {
    // Serialise so concurrent lookups cannot race on the quota/cache files.
    const run = this.chain.then(() => this.doLookup(type, slug, hint));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doLookup(type: ItemType, slug: string, hint?: { versions?: string[] }) {
    if (type !== 'core')
      return this.fetchPath(`${type === 'plugin' ? 'plugins' : 'themes'}/${encodeURIComponent(slug)}`);
    const versions = [...new Set(hint?.versions ?? [])];
    if (versions.length === 0) throw new Error('WPScan core lookup needs a WordPress version');
    const all: Vulnerability[] = [];
    for (const v of versions)
      all.push(...(await this.fetchPath(`wordpresses/${encodeURIComponent(v.replaceAll('.', ''))}`)));
    return all;
  }

  private async fetchPath(path: string): Promise<Vulnerability[]> {
    const now = this.opts.clock.now();
    this.cache ??= (await readJson<Record<string, CacheEntry>>(this.cachePath)) ?? {};
    const hit = this.cache[path];
    if (hit && now.getTime() - Date.parse(hit.fetchedAt) < this.cacheMs) return hit.vulns;

    const day = now.toISOString().slice(0, 10);
    let quota = await readJson<Quota>(this.quotaPath);
    if (quota?.day !== day) quota = { day, used: 0 };
    if (quota.used >= this.limit) throw new QuotaExceededError();
    quota.used++;
    await writeJsonAtomic(this.quotaPath, quota);

    const res = await this.fetchImpl(`${this.base}/${path}`, {
      headers: { Authorization: `Token token=${this.opts.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    let vulns: Vulnerability[] = [];
    if (res.status === 429) {
      await writeJsonAtomic(this.quotaPath, { day, used: this.limit });
      throw new QuotaExceededError('WPScan rate limit reached (HTTP 429)');
    }
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`WPScan HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, { vulnerabilities?: WpscanVuln[] }>;
      const first = Object.values(body)[0];
      vulns = (first?.vulnerabilities ?? []).flatMap((v) => mapWpscanVuln(v) ?? []);
    }
    this.cache[path] = { fetchedAt: now.toISOString(), vulns };
    await writeJsonAtomic(this.cachePath, this.cache);
    return vulns;
  }
}

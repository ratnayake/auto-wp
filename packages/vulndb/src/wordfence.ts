import { join } from 'node:path';
import type { Clock, ItemType, Logger, VersionRange, Vulnerability, VulnProvider } from '@auto-wp/contracts';
import { TopLevelValueSplitter } from './json-stream.js';
import { DAY_MS, type Fetch, readJson, writeJsonAtomic } from './util.js';
import { versionCompare } from './version.js';

export const DEFAULT_WORDFENCE_FEED_URL =
  'https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production';

export interface WordfenceOptions {
  apiKey: string;
  cacheDir: string;
  clock: Clock;
  logger?: Logger;
  /** Defaults to the production feed; `AUTOWP_WORDFENCE_FEED_URL` overrides it when unset. */
  feedUrl?: string;
  fetch?: Fetch;
  refreshMs?: number;
}

interface CacheFile {
  schemaVersion: 1;
  etag?: string;
  fetchedAt: string;
  /** `<type>:<slug>` -> vulnerabilities. */
  index: Record<string, Vulnerability[]>;
}

interface WfRange {
  from_version?: string | null;
  from_inclusive?: boolean;
  to_version?: string | null;
  to_inclusive?: boolean;
}
interface WfSoftware {
  type?: string;
  slug?: string;
  affected_versions?: Record<string, WfRange>;
  patched?: boolean;
  patched_versions?: string[];
}
interface WfRecord {
  id?: string;
  title?: string;
  software?: WfSoftware[];
  cve?: string | null;
  cvss?: { score?: number; rating?: string; vector?: string } | null;
  references?: string[];
}

const wild = (v: string | null | undefined): string => (v == null || v === '' || v === '*' ? '*' : v);

export function mapRange(r: WfRange): VersionRange {
  const from = wild(r.from_version);
  const to = wild(r.to_version);
  return {
    from,
    fromInclusive: from === '*' ? true : (r.from_inclusive ?? true),
    to,
    toInclusive: to === '*' ? true : (r.to_inclusive ?? true),
  };
}

const keyOf = (type: string, slug: string): string => `${type}:${slug.toLowerCase()}`;

/** Maps one raw feed record into per-software vulnerabilities (pure; used by the stream parser). */
export function mapRecord(rec: WfRecord): Array<{ key: string; vuln: Vulnerability }> {
  const out: Array<{ key: string; vuln: Vulnerability }> = [];
  if (!rec.id || !rec.title) return out;
  const cvss =
    rec.cvss && typeof rec.cvss.score === 'number'
      ? {
          score: rec.cvss.score,
          rating: rec.cvss.rating ?? '',
          ...(rec.cvss.vector ? { vector: rec.cvss.vector } : {}),
        }
      : undefined;
  for (const sw of rec.software ?? []) {
    if (sw.type !== 'core' && sw.type !== 'plugin' && sw.type !== 'theme') continue;
    const slug = sw.type === 'core' ? 'wordpress' : sw.slug;
    if (!slug) continue;
    const patched = sw.patched_versions ? [...sw.patched_versions].sort(versionCompare) : [];
    const vuln: Vulnerability = {
      id: rec.id,
      source: 'wordfence',
      ...(rec.cve ? { cve: rec.cve.toUpperCase().startsWith('CVE-') ? rec.cve : `CVE-${rec.cve}` } : {}),
      title: rec.title,
      ...(cvss ? { cvss } : {}),
      affected: Object.values(sw.affected_versions ?? {}).map(mapRange),
      ...(sw.patched && patched[0] ? { fixedIn: patched[0] } : {}),
      references: rec.references ?? [],
    };
    out.push({ key: keyOf(sw.type, slug), vuln });
  }
  return out;
}

export class WordfenceProvider implements VulnProvider {
  readonly name = 'wordfence' as const;
  private readonly url: string;
  private readonly fetchImpl: Fetch;
  private readonly cachePath: string;
  private readonly refreshMs: number;
  private cache?: CacheFile;
  private loading?: Promise<CacheFile>;

  constructor(private readonly opts: WordfenceOptions) {
    this.url = opts.feedUrl ?? process.env.AUTOWP_WORDFENCE_FEED_URL ?? DEFAULT_WORDFENCE_FEED_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    this.cachePath = join(opts.cacheDir, 'wordfence-v3.json');
    this.refreshMs = opts.refreshMs ?? DAY_MS;
  }

  async lookup(type: ItemType, slug: string): Promise<Vulnerability[]> {
    const cache = await this.ensureIndex();
    return cache.index[keyOf(type, type === 'core' ? 'wordpress' : slug)] ?? [];
  }

  private fresh(c: CacheFile): boolean {
    return this.opts.clock.now().getTime() - Date.parse(c.fetchedAt) < this.refreshMs;
  }

  private ensureIndex(): Promise<CacheFile> {
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(): Promise<CacheFile> {
    this.cache ??= await readJson<CacheFile>(this.cachePath);
    if (this.cache?.schemaVersion !== 1) this.cache = undefined;
    if (this.cache && this.fresh(this.cache)) return this.cache;
    try {
      return await this.refresh(this.cache);
    } catch (err) {
      if (this.cache) {
        this.opts.logger?.warn(
          { err: (err as Error).message },
          'wordfence feed refresh failed; using stale index',
        );
        return this.cache;
      }
      throw new Error(`Wordfence feed unavailable: ${(err as Error).message}`);
    }
  }

  private async refresh(old: CacheFile | undefined): Promise<CacheFile> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      Accept: 'application/json',
    };
    if (old?.etag) headers['If-None-Match'] = old.etag;
    const res = await this.fetchImpl(this.url, { headers, signal: AbortSignal.timeout(15 * 60_000) });
    const nowIso = this.opts.clock.now().toISOString();
    if (res.status === 304 && old) {
      const next = { ...old, fetchedAt: nowIso };
      await writeJsonAtomic(this.cachePath, next);
      this.cache = next;
      return next;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    const index: Record<string, Vulnerability[]> = {};
    const splitter = new TopLevelValueSplitter();
    const decoder = new TextDecoder();
    const emit = (raw: string) => {
      for (const { key, vuln } of mapRecord(JSON.parse(raw) as WfRecord)) (index[key] ??= []).push(vuln);
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      splitter.push(decoder.decode(chunk, { stream: true }), emit);
    }
    splitter.push(decoder.decode(), emit);
    const etag = res.headers.get('etag') ?? undefined;
    const next: CacheFile = { schemaVersion: 1, ...(etag ? { etag } : {}), fetchedAt: nowIso, index };
    await writeJsonAtomic(this.cachePath, next);
    this.cache = next;
    this.opts.logger?.info({ slugs: Object.keys(index).length }, 'wordfence feed indexed');
    return next;
  }
}

import type { VersionRange } from '@auto-wp/contracts';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatRange(r: VersionRange): string {
  const lower = r.from ? `${r.fromInclusive ? '>=' : '>'} ${r.from}` : '';
  const upper = r.to ? `${r.toInclusive ? '<=' : '<'} ${r.to}` : '';
  return [lower, upper].filter(Boolean).join(' ') || 'all versions';
}

export function formatCvss(cvss: { score: number; rating: string } | undefined): string {
  return cvss ? `${cvss.score} (${cvss.rating})` : '—';
}

export function formatPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

/** Only http(s) links are rendered as links; feed-supplied URLs may be anything. */
export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function cveUrl(cve: string): string {
  return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve)}`;
}

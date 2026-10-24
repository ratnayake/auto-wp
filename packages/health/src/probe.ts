import type { PageProbe } from '@auto-wp/contracts';

const CRITICAL_RE =
  /There has been a critical error on this website|wp-die-message|(?:PHP )?(?:Fatal|Parse) error:/;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

export interface HttpProbeDeps {
  fetch: typeof fetch;
  cookie?: string;
}

export function hasCriticalError(body: string): boolean {
  return CRITICAL_RE.test(body);
}

export function resolveUrl(base: string, p: string): string {
  return new URL(p, base).toString();
}

export async function httpProbe(url: string, ts: number, d: HttpProbeDeps): Promise<PageProbe> {
  const probe: PageProbe = {
    url,
    status: 0,
    ttfbMs: 0,
    totalMs: 0,
    criticalError: false,
    consoleErrors: [],
    failedRequests: [],
  };
  const start = performance.now();
  let target = new URL(url);
  target.searchParams.set('autowp_nocache', String(ts));
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
      if (d.cookie) headers.Cookie = `autowp_bypass=${d.cookie}`;
      const res = await d.fetch(target, {
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (hop === 0) probe.ttfbMs = Math.round(performance.now() - start);
      probe.status = res.status;
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc && hop < MAX_REDIRECTS) {
        await res.body?.cancel();
        target = new URL(loc, target);
        continue;
      }
      const body = await res.text();
      probe.criticalError = hasCriticalError(body);
      break;
    }
  } catch {
    probe.status = 0;
  }
  probe.totalMs = Math.round(performance.now() - start);
  return probe;
}

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Clock,
  ComparisonResult,
  HealthChecker,
  HealthSnapshot,
  Logger,
  PageProbe,
  SiteConfig,
  SiteConnection,
  Thresholds,
} from '@auto-wp/contracts';
import { type BrowserFactory, capturePage, VIEWPORTS, type ViewportName } from './browser.js';
import { type CompareOptions, comparePage, compareSnapshots } from './compare.js';
import { logSize, scanNewFatals } from './logs.js';
import { httpProbe, resolveUrl } from './probe.js';

export interface HealthCheckerDeps {
  logger: Logger;
  clock: Clock;
  /** Directory for screenshots, text and diff images; one subdirectory per snapshot. */
  artifactsDir: string;
  fetch?: typeof fetch;
  /** Without a browser factory, `snapshot` degrades to HTTP probes only. See `launchChromium`. */
  browser?: BrowserFactory;
  /** Value of the `autowp_bypass` cookie while maintenance mode is on. */
  bypassCookie?: () => Promise<string | undefined> | string | undefined;
  /**
   * `compare().ok` reflects functional failures only (new 4xx/5xx, new critical error). Set this to also
   * fail on visual/slowdown threshold breaches. Default false.
   */
  visualChangesFail?: boolean;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export class DefaultHealthChecker implements HealthChecker {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly d: HealthCheckerDeps) {
    this.fetchFn = d.fetch ?? fetch;
  }

  private urls(site: SiteConfig): string[] {
    return [...new Set(['/', ...site.healthUrls].map((p) => resolveUrl(site.url, p)))];
  }

  private async cookie(): Promise<string | undefined> {
    return (await this.d.bypassCookie?.()) || undefined;
  }

  async snapshot(site: SiteConfig, conn: SiteConnection, label: string): Promise<HealthSnapshot> {
    const now = this.d.clock.now();
    const ts = now.getTime();
    const snapshotId = `${safe(label)}-${ts}`;
    const dir = join(this.d.artifactsDir, snapshotId);
    const cookie = await this.cookie();
    const pages: PageProbe[] = [];
    for (const url of this.urls(site)) {
      pages.push(await httpProbe(url, ts, { fetch: this.fetchFn, cookie }));
    }
    if (this.d.browser) await this.browserPass(site, pages, dir, cookie);
    else this.d.logger.warn({ siteId: site.id }, 'no browser available; health snapshot is HTTP-only');

    const logOffsets: Record<string, number> = {};
    for (const p of site.logFiles) logOffsets[p] = await logSize(conn, p, this.d.logger);
    return { snapshotId, siteId: site.id, label, takenAt: now.toISOString(), pages, logOffsets };
  }

  private async browserPass(site: SiteConfig, pages: PageProbe[], dir: string, cookie?: string) {
    const factory = this.d.browser;
    if (!factory) return;
    let browser: Awaited<ReturnType<BrowserFactory>>;
    try {
      browser = await factory();
    } catch (err) {
      this.d.logger.warn({ err: String(err) }, 'browser launch failed; health snapshot is HTTP-only');
      return;
    }
    try {
      await mkdir(dir, { recursive: true });
      for (const [i, page] of pages.entries()) {
        if (page.status === 0) continue;
        const errs = new Set<string>();
        const failed = new Set<string>();
        for (const vp of Object.keys(VIEWPORTS) as ViewportName[]) {
          try {
            const r = await capturePage(browser, page.url, vp, {
              maskSelectors: site.maskSelectors,
              bypassCookie: cookie,
              outPath: join(dir, `${i}-${vp}.png`),
              captureText: vp === 'desktop',
            });
            page.screenshotPaths = { ...page.screenshotPaths, [vp]: r.screenshotPath };
            for (const e of r.consoleErrors) errs.add(e);
            for (const f of r.failedRequests) failed.add(f);
            if (r.text !== undefined) {
              page.textPath = join(dir, `${i}-text.txt`);
              await writeFile(page.textPath, r.text);
            }
          } catch (err) {
            this.d.logger.warn({ url: page.url, vp, err: String(err) }, 'browser capture failed');
            errs.add(`capture failed (${vp}): ${String(err).slice(0, 200)}`);
          }
        }
        page.consoleErrors = [...errs];
        page.failedRequests = [...failed];
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async quick(site: SiteConfig, conn: SiteConnection, baseline: HealthSnapshot): Promise<ComparisonResult> {
    const ts = this.d.clock.now().getTime();
    const cookie = await this.cookie();
    const pages = [];
    let functional = false;
    for (const [i, b] of baseline.pages.entries()) {
      const after = await httpProbe(b.url, ts, { fetch: this.fetchFn, cookie });
      const r = await comparePage(b, after, undefined, {
        artifactsDir: this.d.artifactsDir,
        diffDir: this.d.artifactsDir,
        index: i,
      });
      pages.push(r.cmp);
      functional ||= r.functional;
    }
    const paths = [...new Set([...Object.keys(baseline.logOffsets), ...site.logFiles])];
    const newLogErrors = await scanNewFatals(conn, paths, baseline.logOffsets, this.d.logger);
    return { ok: !functional && newLogErrors.length === 0, pages, newLogErrors };
  }

  async compare(before: HealthSnapshot, after: HealthSnapshot, t: Thresholds): Promise<ComparisonResult> {
    const o: CompareOptions = {
      artifactsDir: this.d.artifactsDir,
      visualChangesFail: this.d.visualChangesFail ?? false,
    };
    return compareSnapshots(before, after, t, o);
  }
}

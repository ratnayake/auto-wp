import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { normalizeText } from './normalize.js';

export type BrowserFactory = () => Promise<Browser>;

/** Lazily imports Playwright so the package works (HTTP-only) where it is not installed. */
export const launchChromium: BrowserFactory = async () => {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
};

export const VIEWPORTS = {
  desktop: { width: 1366, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export const MAX_FULLPAGE_PX = 8000;
const NETWORK_IDLE_TIMEOUT_MS = 8000;
const NAV_TIMEOUT_MS = 30_000;
const IGNORED_HOSTS =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|facebook\.net|facebook\.com\/tr|hotjar|clarity\.ms|stats\.wp\.com|pixel\.wp\.com|gravatar\.com)/i;
const IGNORED_PATHS = /\/favicon\.(ico|png|svg)(\?|$)/i;

const FREEZE_CSS = `*,*::before,*::after{animation:none!important;animation-play-state:paused!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}`;

export interface BrowserPageResult {
  screenshotPath: string;
  consoleErrors: string[];
  failedRequests: string[];
  text?: string;
}

function ignored(url: string): boolean {
  return IGNORED_HOSTS.test(url) || IGNORED_PATHS.test(url);
}

export async function capturePage(
  browser: Browser,
  url: string,
  vp: ViewportName,
  o: { maskSelectors: string[]; bypassCookie?: string; outPath: string; captureText: boolean },
): Promise<BrowserPageResult> {
  const context = await browser.newContext({
    viewport: VIEWPORTS[vp],
    reducedMotion: 'reduce',
    isMobile: vp === 'mobile',
    extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
  });
  try {
    const target = new URL(url);
    if (o.bypassCookie) {
      await context.addCookies([
        { name: 'autowp_bypass', value: o.bypassCookie, domain: target.hostname, path: '/' },
      ]);
    }
    const page = await context.newPage();
    const consoleErrors = new Set<string>();
    const failedRequests = new Set<string>();
    page.on('console', (m) => {
      if (m.type() === 'error' && !ignored(m.location().url ?? '')) {
        consoleErrors.add(m.text().slice(0, 300));
      }
    });
    page.on('pageerror', (e) => consoleErrors.add(`pageerror: ${e.message}`.slice(0, 300)));
    page.on('requestfailed', (r) => {
      if (!ignored(r.url()))
        failedRequests.add(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`.trim());
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && r.request().resourceType() !== 'document' && !ignored(r.url())) {
        failedRequests.add(`${r.request().method()} ${r.url()} ${r.status()}`);
      }
    });
    const nt = new URL(url);
    nt.searchParams.set('autowp_nocache', String(Date.now()));
    await page.goto(nt.toString(), { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
    await page.addStyleTag({ content: FREEZE_CSS });
    const height = (await page.evaluate('document.documentElement.scrollHeight')) as number;
    const mask = o.maskSelectors.map((s) => page.locator(s));
    const shot = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      mask,
      ...(height > MAX_FULLPAGE_PX
        ? { clip: { x: 0, y: 0, width: VIEWPORTS[vp].width, height: MAX_FULLPAGE_PX } }
        : {}),
    });
    await mkdir(join(o.outPath, '..'), { recursive: true });
    await writeFile(o.outPath, shot);
    const text = o.captureText
      ? normalizeText((await page.evaluate("document.body ? document.body.innerText : ''")) as string)
      : undefined;
    return {
      screenshotPath: o.outPath,
      consoleErrors: [...consoleErrors],
      failedRequests: [...failedRequests],
      text,
    };
  } finally {
    await context.close();
  }
}

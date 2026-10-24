import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ComparisonResult,
  type HealthSnapshot,
  type PageComparison,
  type PageProbe,
  type Thresholds,
  ThresholdsSchema,
} from '@auto-wp/contracts';
import { createTwoFilesPatch } from 'diff';
import { diffPngFiles } from './pixel.js';

const MAX_DIFF_LINES = 200;
const VPS = ['desktop', 'mobile'] as const;

export interface CompareOptions {
  /** If true, visual/perf problems (pixel diff, slowdown) also make `ok` false. Default false. */
  visualChangesFail?: boolean;
  artifactsDir: string;
}

const isBad = (s: number) => s === 0 || s >= 400;

export function truncateLines(s: string, max = MAX_DIFF_LINES): string {
  const lines = s.split('\n');
  return lines.length <= max
    ? s
    : `${lines.slice(0, max).join('\n')}\n... (${lines.length - max} more lines truncated)`;
}

async function readText(p?: string): Promise<string | undefined> {
  if (!p) return undefined;
  try {
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

export interface PageResult {
  cmp: PageComparison;
  /** Functional failure: new 4xx/5xx, new critical error. */
  functional: boolean;
}

export async function comparePage(
  before: PageProbe | undefined,
  after: PageProbe | undefined,
  t: Thresholds | undefined,
  o: { artifactsDir: string; diffDir: string; index: number },
): Promise<PageResult> {
  const url = (after ?? before)?.url ?? '';
  const problems: string[] = [];
  let functional = false;
  if (!after) {
    return {
      functional: true,
      cmp: {
        url,
        statusBefore: before?.status ?? 0,
        statusAfter: 0,
        statusChanged: true,
        criticalError: false,
        newConsoleErrors: [],
        newFailedRequests: [],
        slowdownMs: 0,
        problems: ['page missing from the after snapshot'],
      },
    };
  }
  const statusBefore = before?.status ?? 0;
  const cmp: PageComparison = {
    url,
    statusBefore,
    statusAfter: after.status,
    statusChanged: before !== undefined && statusBefore !== after.status,
    criticalError: after.criticalError,
    newConsoleErrors: after.consoleErrors.filter((e) => !before?.consoleErrors.includes(e)),
    newFailedRequests: after.failedRequests.filter((e) => !before?.failedRequests.includes(e)),
    slowdownMs: before ? Math.round(after.totalMs - before.totalMs) : 0,
    problems,
  };
  if (isBad(after.status) && (!before || !isBad(before.status))) {
    problems.push(`HTTP status went from ${statusBefore || 'n/a'} to ${after.status || 'no response'}`);
    functional = true;
  }
  if (after.criticalError && !before?.criticalError) {
    problems.push('WordPress/PHP critical error detected in page body');
    functional = true;
  }
  if (!before) return { cmp, functional };

  if (t) {
    for (const vp of VPS) {
      const b = before.screenshotPaths?.[vp];
      const a = after.screenshotPaths?.[vp];
      if (!b || !a) continue;
      await mkdir(o.diffDir, { recursive: true });
      const out = join(o.diffDir, `diff-${o.index}-${vp}.png`);
      const pct = await diffPngFiles(b, a, out);
      cmp.pixelDiffPct = { ...cmp.pixelDiffPct, [vp]: pct };
      if (pct > 0) cmp.diffImagePaths = { ...cmp.diffImagePaths, [vp]: out };
      if (pct > t.pixelDiffPct) {
        problems.push(`${vp} screenshot differs by ${pct}% (threshold ${t.pixelDiffPct}%)`);
      }
    }
    const allowed = Math.max(before.totalMs * (t.slowdownFactor - 1), t.slowdownMinMs);
    if (cmp.slowdownMs > allowed) {
      problems.push(`response ${cmp.slowdownMs}ms slower (allowed ${Math.round(allowed)}ms)`);
    }
  }
  const [bt, at] = await Promise.all([readText(before.textPath), readText(after.textPath)]);
  if (bt !== undefined && at !== undefined && bt !== at) {
    cmp.textDiff = truncateLines(createTwoFilesPatch(url, url, bt, at, 'before', 'after', { context: 2 }));
  }
  return { cmp, functional };
}

export async function compareSnapshots(
  before: HealthSnapshot,
  after: HealthSnapshot,
  thresholds: Thresholds,
  o: CompareOptions,
): Promise<ComparisonResult> {
  const t = ThresholdsSchema.parse(thresholds);
  const diffDir = join(o.artifactsDir, after.snapshotId);
  const pages: PageComparison[] = [];
  let functional = false;
  let any = false;
  const seen = new Set<string>();
  let i = 0;
  for (const a of after.pages) {
    seen.add(a.url);
    const r = await comparePage(
      before.pages.find((p) => p.url === a.url),
      a,
      t,
      { ...o, diffDir, index: i++ },
    );
    pages.push(r.cmp);
    functional ||= r.functional;
    any ||= r.cmp.problems.length > 0;
  }
  for (const b of before.pages) {
    if (seen.has(b.url)) continue;
    const r = await comparePage(b, undefined, t, { ...o, diffDir, index: i++ });
    pages.push(r.cmp);
    functional ||= r.functional;
    any = true;
  }
  return { ok: !functional && !(o.visualChangesFail && any), pages, newLogErrors: [] };
}

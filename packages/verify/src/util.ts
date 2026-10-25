import { createHash } from 'node:crypto';

export async function sha256Stream(
  source: NodeJS.ReadableStream,
): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of source as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bytes += b.length;
    h.update(b);
  }
  return { sha256: h.digest('hex'), bytes };
}

export interface Tolerance {
  /** Absolute slack. */
  abs: number;
  /** Fractional slack of the expected value (0.005 = 0.5%). */
  pct: number;
}

export const DEFAULT_FILE_TOLERANCE: Tolerance = { abs: 5, pct: 0.005 };
export const DEFAULT_VOLATILE_ROW_TOLERANCE: Tolerance = { abs: 25, pct: 0.2 };

/** True when |actual - expected| <= max(abs, pct * expected). */
export function withinTolerance(expected: number, actual: number, t: Tolerance): boolean {
  return Math.abs(actual - expected) <= Math.max(t.abs, t.pct * Math.abs(expected));
}

const BUILTIN_VOLATILE = [
  /(_sessions|_actionscheduler_logs|_wc_sessions|_wfLiveTraffic|_wflogs|_yoast_indexable)$/i,
  /_statistics/i,
];

export function isVolatileTable(name: string, extra: readonly RegExp[] = []): boolean {
  return [...BUILTIN_VOLATILE, ...extra].some((re) => re.test(name));
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

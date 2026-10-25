import type { Logger, SiteConnection } from '@auto-wp/contracts';

const FATAL_RE = /PHP (?:Fatal error|Parse error)|Uncaught|PHP Warning:.*(?:include|require)/;
const CHUNK = 1024 * 1024;
const MAX_CHUNKS = 8;
export const MAX_LOG_LINES = 50;
const MAX_LINE_LEN = 500;

export function extractFatalLines(data: string, cap = MAX_LOG_LINES): string[] {
  const seen = new Set<string>();
  for (const raw of data.split('\n')) {
    if (!FATAL_RE.test(raw)) continue;
    // Strip the leading [timestamp] so repeated errors dedupe.
    const line = raw
      .replace(/^\[[^\]]*\]\s*/, '')
      .trim()
      .slice(0, MAX_LINE_LEN);
    seen.add(line);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

/** Current size of a remote log; 0 if confirmed absent; undefined if unreadable (offset unknown). */
export async function logSize(conn: SiteConnection, path: string, log: Logger): Promise<number | undefined> {
  try {
    const r = await conn.call('logs.tail', { path, fromOffset: 0, maxBytes: 1 });
    return r.size;
  } catch (err) {
    if (/ENOENT|not.?found|no such file|does not exist/i.test(String(err))) return 0;
    log.warn({ path, err: String(err) }, 'log size unreadable; baseline offset unknown');
    return undefined;
  }
}

/** Read bytes added since `offset`; a shrunken file (rotation) is read from 0. */
export async function readNewLog(
  conn: SiteConnection,
  path: string,
  offset: number,
  log: Logger,
): Promise<string> {
  let cur = offset;
  let data = '';
  let first = true;
  try {
    for (let i = 0; i < MAX_CHUNKS; i++) {
      let r = await conn.call('logs.tail', { path, fromOffset: cur, maxBytes: CHUNK });
      if (first && cur > 0 && (r.rotated || r.size < cur)) {
        cur = 0;
        r = await conn.call('logs.tail', { path, fromOffset: 0, maxBytes: CHUNK });
      }
      first = false;
      data += r.data;
      if (!r.data || r.nextOffset >= r.size || r.nextOffset <= cur) break;
      cur = r.nextOffset;
    }
  } catch (err) {
    log.debug({ path, err: String(err) }, 'log not readable; skipping');
  }
  return data;
}

export async function scanNewFatals(
  conn: SiteConnection,
  paths: string[],
  offsets: Record<string, number>,
  log: Logger,
): Promise<string[]> {
  const out = new Set<string>();
  for (const p of paths) {
    const known = offsets[p];
    if (known === undefined) {
      log.warn({ path: p }, 'log baseline unknown; not scanning pre-existing content');
      continue;
    }
    const data = await readNewLog(conn, p, known, log);
    for (const l of extractFatalLines(data)) out.add(`${p}: ${l}`);
  }
  return [...out].slice(0, MAX_LOG_LINES);
}

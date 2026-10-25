import type { z } from 'zod';

/**
 * Slugs are passed as argv: no leading `-` (never read as a WP-CLI option) and not `.` or `..` (never a path
 * component).
 */
export const SLUG_PATTERN = /^(?!\.\.?$)[a-z0-9_.][a-z0-9_.-]*$/i;

/** WordPress and plugin versions start with a digit; anything else is treated as noise. */
export const VERSION_PATTERN = /^\d[0-9A-Za-z.+~_-]*$/;

const lines = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** Last line matching a version, so PHP notices printed before or after the value are ignored. */
export function extractVersion(stdout: string): string | undefined {
  return lines(stdout)
    .filter((l) => VERSION_PATTERN.test(l))
    .at(-1);
}

/**
 * Last line that is a valid slug, for single-value `--field` output. Notices are printed with spaces and
 * rarely form a valid slug, so they are skipped.
 */
export function extractSlug(stdout: string): string | undefined {
  return lines(stdout)
    .filter((l) => SLUG_PATTERN.test(l))
    .at(-1);
}

/**
 * Parses the JSON payload from WP-CLI stdout even when PHP warnings or notices are printed before or after it.
 * Tries the whole output first, then every line that opens an array or object, ending at each closing bracket
 * from the last. The first candidate that also satisfies `schema` wins. Returns undefined when none does.
 */
export function extractJson<T>(stdout: string, schema: z.ZodType<T>): T | undefined {
  const text = stdout.trim();
  const attempt = (candidate: string): T | undefined => {
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = attempt(text);
  if (whole !== undefined) return whole;

  for (let start = 0; start < text.length; start++) {
    const opener = text.charAt(start);
    if ((opener !== '[' && opener !== '{') || (start > 0 && text.charAt(start - 1) !== '\n')) continue;
    const closer = opener === '[' ? ']' : '}';
    for (let end = text.lastIndexOf(closer); end > start; end = text.lastIndexOf(closer, end - 1)) {
      const hit = attempt(text.slice(start, end + 1));
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

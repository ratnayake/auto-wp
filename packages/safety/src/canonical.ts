import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively; undefined values and functions are dropped like JSON.stringify. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof (o as { toJSON?: unknown }).toJSON === 'function') {
      return sortKeys((o as { toJSON(): unknown }).toJSON());
    }
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

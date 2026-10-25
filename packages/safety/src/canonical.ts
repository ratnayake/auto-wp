import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted (by UTF-16 code unit) recursively. Serialised by hand because building an
 * intermediate object would let the engine re-order integer-like keys. undefined hashes as null at top level.
 */
export function canonicalJson(value: unknown): string {
  return ser(value) ?? 'null';
}

function ser(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const toJSON = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') return ser(toJSON.call(v));
    if (Array.isArray(v)) return `[${v.map((x) => ser(x) ?? 'null').join(',')}]`;
    const o = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(o).sort()) {
      const s = ser(o[k]);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(v);
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

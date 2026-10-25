import type { VersionRange } from '@auto-wp/contracts';

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isAlnum = (c: string): boolean => isDigit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isNonDigit = (c: string): boolean => !isDigit(c) && c !== '.';

/** Port of PHP's php_canonicalize_version. */
function canonicalize(v: string): string {
  if (v === '') return '';
  let out = v[0] as string;
  let prev = out;
  for (let i = 1; i < v.length; i++) {
    const c = v[i] as string;
    const last = out[out.length - 1];
    if (c === '-' || c === '_' || c === '+') {
      if (last !== '.') out += '.';
    } else if ((isNonDigit(prev) && isDigit(c)) || (isDigit(prev) && isNonDigit(c))) {
      if (last !== '.') out += '.';
      out += c;
    } else if (!isAlnum(c)) {
      if (last !== '.') out += '.';
    } else {
      out += c;
    }
    prev = c;
  }
  return out;
}

const SPECIAL_FORMS: Array<[string, number]> = [
  ['dev', 0],
  ['alpha', 1],
  ['a', 1],
  ['beta', 2],
  ['b', 2],
  ['RC', 3],
  ['rc', 3],
  ['#', 4],
  ['pl', 5],
  ['p', 5],
];

function specialOrder(s: string): number {
  for (const [name, order] of SPECIAL_FORMS) if (s.startsWith(name)) return order;
  return -6;
}

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

function compareSpecial(a: string, b: string): -1 | 0 | 1 {
  return sign(specialOrder(a) - specialOrder(b));
}

function compareCanonical(a: string, b: string): -1 | 0 | 1 {
  if (a === '' && b === '') return 0;
  if (a === '') return -1;
  if (b === '') return 1;
  const pa = a.split('.');
  const pb = b.split('.');
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    const dx = isDigit(x[0] ?? '');
    const dy = isDigit(y[0] ?? '');
    let r: -1 | 0 | 1;
    if (dx && dy) {
      const nx = BigInt(/^\d+/.exec(x)?.[0] ?? '0');
      const ny = BigInt(/^\d+/.exec(y)?.[0] ?? '0');
      r = nx < ny ? -1 : nx > ny ? 1 : 0;
    } else if (!dx && !dy) r = compareSpecial(x, y);
    else if (dx) r = compareSpecial('#N#', y);
    else r = compareSpecial(x, '#N#');
    if (r !== 0) return r;
  }
  if (pa.length > n) {
    return isDigit((pa[n] as string)[0] ?? '') ? 1 : compareCanonical(pa.slice(n).join('.'), '#N#');
  }
  if (pb.length > n) {
    return isDigit((pb[n] as string)[0] ?? '') ? -1 : compareCanonical('#N#', pb.slice(n).join('.'));
  }
  return 0;
}

/** PHP `version_compare()` compatible. */
export function versionCompare(a: string, b: string): -1 | 0 | 1 {
  return compareCanonical(canonicalize(a), canonicalize(b));
}

/** `*` (or empty) on either bound means unbounded. */
export function inRange(version: string, r: VersionRange): boolean {
  if (r.from !== '*' && r.from !== '') {
    const c = versionCompare(version, r.from);
    if (c < 0 || (c === 0 && !r.fromInclusive)) return false;
  }
  if (r.to !== '*' && r.to !== '') {
    const c = versionCompare(version, r.to);
    if (c > 0 || (c === 0 && !r.toInclusive)) return false;
  }
  return true;
}

export const inAnyRange = (version: string, ranges: VersionRange[]): boolean =>
  ranges.some((r) => inRange(version, r));

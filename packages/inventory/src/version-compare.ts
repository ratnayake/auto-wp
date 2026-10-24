/**
 * PHP-compatible `version_compare()` (ext/standard/versioning.c, PHP 8.4), returning -1, 0 or 1.
 * Pinned against the local PHP CLI by test/fixtures/version-compare.json.
 */

// Order matters: prefix matching picks the first entry, so `pl` must precede `p`.
const SPECIAL_FORMS: ReadonlyArray<readonly [string, number]> = [
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

type Sign = -1 | 0 | 1;

const sign = (n: number): Sign => (n < 0 ? -1 : n > 0 ? 1 : 0);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isNonDigit = (c: string): boolean => !isDigit(c) && c !== '.';
const isSeparator = (c: string): boolean => c === '-' || c === '_' || c === '+';
const isAlnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);

function specialOrder(form: string): number {
  for (const [name, order] of SPECIAL_FORMS) {
    if (form.startsWith(name)) return order;
  }
  return -1;
}

function compareSpecial(a: string, b: string): Sign {
  return sign(specialOrder(a) - specialOrder(b));
}

/** Inserts `.` at separators and alpha/digit transitions, mirroring php_canonicalize_version(). */
export function canonicalize(version: string): string {
  if (version.length === 0) return '';
  let out = version.charAt(0);
  let prev = out;
  for (let i = 1; i < version.length; i++) {
    const ch = version.charAt(i);
    // PHP checks the last character written, not the last one read.
    const needsDot = out.charAt(out.length - 1) !== '.';
    if (isSeparator(ch)) {
      if (needsDot) out += '.';
    } else if ((isNonDigit(prev) && isDigit(ch)) || (isDigit(prev) && isNonDigit(ch))) {
      if (needsDot) out += '.';
      out += ch;
    } else if (!isAlnum(ch)) {
      if (needsDot) out += '.';
    } else {
      out += ch;
    }
    prev = ch;
  }
  return out;
}

function compareToken(a: string, b: string): Sign {
  const digitA = isDigit(a.charAt(0));
  const digitB = isDigit(b.charAt(0));
  if (digitA && digitB) {
    const x = BigInt(/^\d*/.exec(a)?.[0] ?? '0');
    const y = BigInt(/^\d*/.exec(b)?.[0] ?? '0');
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (!digitA && !digitB) return compareSpecial(a, b);
  return digitA ? compareSpecial('#N#', b) : compareSpecial(a, '#N#');
}

function compareCanonical(v1: string, v2: string): Sign {
  const t1 = v1.split('.');
  const t2 = v2.split('.');
  const shared = Math.min(t1.length, t2.length);
  for (let i = 0; i < shared; i++) {
    const c = compareToken(t1[i] ?? '', t2[i] ?? '');
    if (c !== 0) return c;
  }
  if (t1.length > shared) {
    const rest = t1.slice(shared).join('.');
    return isDigit(rest.charAt(0)) ? 1 : versionCompare(rest, '#N#');
  }
  if (t2.length > shared) {
    const rest = t2.slice(shared).join('.');
    return isDigit(rest.charAt(0)) ? -1 : versionCompare('#N#', rest);
  }
  return 0;
}

export function versionCompare(a: string, b: string): Sign {
  if (a === '' || b === '') {
    if (a === '' && b === '') return 0;
    return a === '' ? -1 : 1;
  }
  const v1 = a.startsWith('#') ? a : canonicalize(a);
  const v2 = b.startsWith('#') ? b : canonicalize(b);
  return compareCanonical(v1, v2);
}

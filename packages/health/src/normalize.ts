const MONTHS =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  new RegExp(`\\b${MONTHS}\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTHS}\\.?(?:,? \\d{4})?\\b`, 'gi'),
];
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi;
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;
// Mixed letters+digits tokens of 16+ chars: nonces, session ids, asset hashes.
const TOKEN_RE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g;

/**
 * Normalise visible text so that two renders of an unchanged page compare equal: collapse
 * whitespace per line, drop blank-line runs, and replace volatile dates/times/nonces by placeholders.
 */
export function normalizeText(raw: string): string {
  let t = raw.replace(/\r/g, '').replace(/ /g, ' ');
  for (const re of DATE_RES) t = t.replace(re, '<DATE>');
  t = t.replace(TIME_RE, '<TIME>').replace(HEX_RE, '<HEX>').replace(TOKEN_RE, '<TOKEN>');
  const lines = t.split('\n').map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

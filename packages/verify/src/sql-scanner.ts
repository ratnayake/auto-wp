import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { DUMP_TERMINATOR_PREFIX } from '@auto-wp/contracts';

export interface SqlScanResult {
  /** Names of tables created by `CREATE TABLE`, in order of appearance, de-duplicated. */
  createTables: string[];
  /** Number of VALUES tuples per table across all INSERT/REPLACE statements. */
  rowsPerTable: Map<string, number>;
  /** True when the last significant content of the dump is the `-- Dump completed` comment. */
  terminator: boolean;
  /** True when the input ended inside a string, comment or unfinished statement. */
  truncated: boolean;
  /** Decoded bytes scanned. */
  bytes: number;
}

// Lexer states.
const NORMAL = 0;
const SQ = 1;
const DQ = 2;
const BT = 3;
const BT_END = 4;
const DASH1 = 5;
const DASH2 = 6;
const LINE = 7;
const BLOCK = 8;
const SLASH = 9;
const DELIM_LINE = 10;

// Statement modes.
const M_START = 0;
const M_CREATE = 1;
const M_INSERT = 2;
const M_VALUES = 3;
const M_SKIP = 4;

type TokKind = 'w' | 'i' | 'p' | 's';
interface Tok {
  k: TokKind;
  v: string;
}

const MAX_WORD = 64;
const MAX_IDENT = 1024;
const MAX_HEAD = 24;
/** Comment body of the contracts terminator (`-- Dump completed`), compared case-insensitively. */
const TERMINATOR_PREFIX = DUMP_TERMINATOR_PREFIX.replace(/^--\s*/, '').toLowerCase();
const SQ_RE = /['\\]/g;
const DQ_RE = /["\\]/g;
const BT_RE = /`/g;

const CREATE_SKIP = new Set(['CREATE', 'OR', 'REPLACE', 'TEMPORARY', 'TABLE', 'IF', 'NOT', 'EXISTS']);
const INSERT_SKIP = new Set([
  'INSERT',
  'REPLACE',
  'LOW_PRIORITY',
  'DELAYED',
  'HIGH_PRIORITY',
  'IGNORE',
  'INTO',
]);

const isWordCode = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 128;

/** Names come from a latin1-decoded byte stream; restore the original UTF-8. */
const decodeName = (s: string): string => Buffer.from(s, 'latin1').toString('utf8');

/** Last name of a possibly schema-qualified chain (`db`.`t`) after skipping leading keywords. */
function parseName(head: Tok[], skip: Set<string>): string | undefined {
  let i = 0;
  while (i < head.length && head[i]?.k === 'w' && skip.has(head[i]?.v.toUpperCase() ?? '')) i++;
  let name: string | undefined;
  while (i < head.length) {
    const t = head[i];
    if (!t || (t.k !== 'i' && t.k !== 'w')) break;
    name = t.v;
    const dot = head[i + 1];
    if (dot?.k === 'p' && dot.v === '.') i += 2;
    else break;
  }
  return name === undefined ? undefined : decodeName(name);
}

/**
 * Incremental, quote-aware scanner for SQL dumps. Feed chunks with `write`, then call `finish`.
 * State is carried across chunk boundaries, so tokens may be split anywhere. Memory use is O(1) in
 * the input size: strings are skipped without being captured.
 *
 * Executable comments (`/*!40101 ... *\/`) are treated as comments: mysqldump only uses them for SET and
 * ALTER ... KEYS statements, never for data or CREATE TABLE.
 */
export class SqlScanner {
  private state = NORMAL;
  private word = '';
  private ident = '';
  private line = '';
  private star = false; // block comment: previous char was '*'
  private esc = false; // inside quote: previous char was a backslash
  private delimiter = ';';
  private dpos = 0;
  private delimBuf = '';

  private mode = M_START;
  private head: Tok[] = [];
  private depth = 0;
  private expectTuple = false;
  private table = '';

  private readonly created: string[] = [];
  private readonly createdSet = new Set<string>();
  private readonly rows = new Map<string, number>();
  private terminator = false;
  private bytes = 0;

  write(chunk: Buffer | string): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    this.bytes += s.length;
    this.scan(s);
  }

  finish(): SqlScanResult {
    // Flush a token pending at EOF.
    if (this.state === NORMAL) this.endWord();
    else if (this.state === BT_END) this.emit('i', this.ident);
    else if (this.state === DASH2 || this.state === LINE) this.endLine();
    else if (this.state === DASH1) this.emit('p', '-');
    const truncated =
      this.state === SQ ||
      this.state === DQ ||
      this.state === BT ||
      this.state === BLOCK ||
      this.state === DELIM_LINE ||
      this.dpos > 0 ||
      (this.mode !== M_START && this.mode !== M_SKIP) ||
      (this.mode === M_SKIP && this.pendingStatement);
    return {
      createTables: [...this.created],
      rowsPerTable: new Map(this.rows),
      terminator: this.terminator && !truncated,
      truncated,
      bytes: this.bytes,
    };
  }

  /** True while a skipped statement has not yet seen its delimiter. */
  private pendingStatement = false;

  private scan(s: string): void {
    const n = s.length;
    for (let i = 0; i < n; i++) {
      switch (this.state) {
        case SQ:
        case DQ: {
          if (this.esc) {
            this.esc = false;
            break;
          }
          const re = this.state === SQ ? SQ_RE : DQ_RE;
          re.lastIndex = i;
          const m = re.exec(s);
          if (!m) {
            i = n;
            break;
          }
          i = m.index;
          if (s.charCodeAt(i) === 92) {
            if (i + 1 < n) i++;
            else this.esc = true;
          } else {
            this.state = NORMAL;
            this.emit('s', '');
          }
          break;
        }
        case BT: {
          BT_RE.lastIndex = i;
          const m = BT_RE.exec(s);
          const end = m ? m.index : n;
          if (this.ident.length < MAX_IDENT) this.ident += s.slice(i, Math.min(end, i + MAX_IDENT));
          if (m) this.state = BT_END;
          i = end;
          break;
        }
        case BT_END:
          if (s.charCodeAt(i) === 96) {
            this.ident += '`';
            this.state = BT;
          } else {
            this.state = NORMAL;
            this.emit('i', this.ident);
            i--;
          }
          break;
        case LINE: {
          const nl = s.indexOf('\n', i);
          const end = nl < 0 ? n : nl;
          if (this.line.length < 40) this.line += s.slice(i, Math.min(end, i + 40));
          if (nl >= 0) this.endLine();
          i = end;
          break;
        }
        case BLOCK: {
          const c = s.charCodeAt(i);
          if (c === 47 && this.star) {
            this.state = NORMAL;
            this.star = false;
          } else this.star = c === 42;
          break;
        }
        case DASH1:
          if (s.charCodeAt(i) === 45) this.state = DASH2;
          else {
            this.state = NORMAL;
            this.emit('p', '-');
            i--;
          }
          break;
        case DASH2: {
          const c = s.charCodeAt(i);
          // MySQL: `--` starts a comment only when followed by whitespace or a control character.
          if (c <= 32) {
            this.state = LINE;
            this.line = '';
            i--;
          } else {
            this.state = NORMAL;
            this.emit('p', '-');
            this.emit('p', '-');
            i--;
          }
          break;
        }
        case SLASH:
          if (s.charCodeAt(i) === 42) {
            this.state = BLOCK;
            this.star = false;
          } else {
            this.state = NORMAL;
            this.emit('p', '/');
            i--;
          }
          break;
        case DELIM_LINE: {
          const nl = s.indexOf('\n', i);
          const end = nl < 0 ? n : nl;
          this.delimBuf += s.slice(i, end);
          if (nl >= 0) {
            const d = this.delimBuf.trim();
            if (d) this.delimiter = d;
            this.delimBuf = '';
            this.state = NORMAL;
          }
          i = end;
          break;
        }
        default:
          i = this.normal(s, i);
      }
    }
  }

  /** Handle one char in NORMAL state; returns the index to continue from (may step back to re-read). */
  private normal(s: string, i: number): number {
    const c = s.charCodeAt(i);
    if (isWordCode(c)) {
      if (this.word.length < MAX_WORD) this.word += s[i];
      return i;
    }
    if (this.word) {
      this.endWord();
      if (this.state !== NORMAL) return i - 1; // DELIMITER switched us into DELIM_LINE; re-read char there
    }
    // Delimiter (default `;`, or whatever a DELIMITER directive set).
    const d = this.delimiter;
    if (c === d.charCodeAt(this.dpos)) {
      this.dpos++;
      if (this.dpos === d.length) {
        this.dpos = 0;
        this.onDelimiter();
      }
      return i;
    }
    if (this.dpos > 0) {
      const partial = d.slice(0, this.dpos);
      this.dpos = 0;
      for (const ch of partial) this.emit('p', ch);
      return i - 1;
    }
    switch (c) {
      case 39:
        this.state = SQ;
        this.esc = false;
        break;
      case 34:
        this.state = DQ;
        this.esc = false;
        break;
      case 96:
        this.state = BT;
        this.ident = '';
        break;
      case 45:
        this.state = DASH1;
        break;
      case 35:
        this.state = LINE;
        this.line = '';
        break;
      case 47:
        this.state = SLASH;
        break;
      case 40:
      case 41:
      case 44:
      case 46:
      case 59:
        this.emit('p', s[i] as string);
        break;
      default:
        if (c > 32) this.emit('p', s[i] as string);
    }
    return i;
  }

  private endWord(): void {
    const w = this.word;
    this.word = '';
    if (!w) return;
    if (this.mode === M_START && w.toUpperCase() === 'DELIMITER') {
      this.terminator = false;
      this.state = DELIM_LINE;
      this.delimBuf = '';
      return;
    }
    this.emit('w', w);
  }

  private endLine(): void {
    this.state = NORMAL;
    if (this.line.trim().toLowerCase().startsWith(TERMINATOR_PREFIX)) this.terminator = true;
    this.line = '';
  }

  private onDelimiter(): void {
    if (this.mode === M_CREATE) this.registerCreate();
    this.mode = M_START;
    this.head = [];
    this.depth = 0;
    this.pendingStatement = false;
    this.terminator = false;
  }

  private registerCreate(): void {
    // Only plain tables: CREATE PROCEDURE/VIEW/TRIGGER etc. never reach a `TABLE` keyword.
    const isTable = this.head.slice(0, 4).some((t) => t.k === 'w' && t.v.toUpperCase() === 'TABLE');
    const name = isTable ? parseName(this.head, CREATE_SKIP) : undefined;
    if (name !== undefined && !this.createdSet.has(name)) {
      this.createdSet.add(name);
      this.created.push(name);
    }
  }

  private emit(k: TokKind, raw: string): void {
    this.terminator = false;
    // Keywords compare upper-cased; the original case is kept for unquoted table names.
    const v = k === 'w' ? raw.toUpperCase() : raw;
    const tok: Tok = { k, v: raw };
    switch (this.mode) {
      case M_START:
        this.pendingStatement = true;
        this.head = [];
        this.depth = 0;
        if (k === 'w' && v === 'CREATE') {
          this.mode = M_CREATE;
          this.head.push(tok);
        } else if (k === 'w' && (v === 'INSERT' || v === 'REPLACE')) {
          this.mode = M_INSERT;
          this.head.push(tok);
        } else this.mode = M_SKIP;
        return;
      case M_CREATE:
        if ((k === 'p' && v === '(') || (k === 'w' && (v === 'LIKE' || v === 'AS' || v === 'SELECT'))) {
          this.registerCreate();
          this.mode = M_SKIP;
        } else if (this.head.length < MAX_HEAD) this.head.push(tok);
        return;
      case M_INSERT:
        if (k === 'p' && v === '(') this.depth++;
        else if (k === 'p' && v === ')') this.depth = Math.max(0, this.depth - 1);
        else if (this.depth === 0 && k === 'w') {
          if (v === 'VALUES' || v === 'VALUE') {
            this.table = parseName(this.head, INSERT_SKIP) ?? '';
            this.mode = this.table ? M_VALUES : M_SKIP;
            this.expectTuple = true;
            return;
          }
          if (v === 'SELECT' || v === 'SET') {
            this.mode = M_SKIP;
            return;
          }
        }
        if (this.depth === 0 && this.head.length < MAX_HEAD) this.head.push(tok);
        return;
      case M_VALUES:
        if (k === 'p') {
          if (v === '(') {
            if (this.depth === 0) {
              if (!this.expectTuple) {
                this.mode = M_SKIP;
                return;
              }
              this.rows.set(this.table, (this.rows.get(this.table) ?? 0) + 1);
            }
            this.depth++;
          } else if (v === ')') {
            this.depth = Math.max(0, this.depth - 1);
            if (this.depth === 0) this.expectTuple = false;
          } else if (v === ',' && this.depth === 0) this.expectTuple = true;
        } else if (k === 'w' && this.depth === 0) {
          this.mode = M_SKIP; // e.g. ON DUPLICATE KEY UPDATE ... VALUES(col)
        }
        return;
      default:
    }
  }
}

/** Scan a (possibly huge) plain-text SQL stream. */
export async function scanSqlStream(source: Readable | NodeJS.ReadableStream): Promise<SqlScanResult> {
  const scanner = new SqlScanner();
  for await (const chunk of source as AsyncIterable<Buffer | string>) scanner.write(chunk);
  return scanner.finish();
}

/** Scan a gzipped SQL stream; rejects on corrupt or truncated gzip data. */
export async function scanGzipSqlStream(source: Readable | NodeJS.ReadableStream): Promise<SqlScanResult> {
  const scanner = new SqlScanner();
  await pipeline(source as Readable, createGunzip(), async (decoded: AsyncIterable<Buffer>) => {
    for await (const chunk of decoded) scanner.write(chunk);
  });
  return scanner.finish();
}

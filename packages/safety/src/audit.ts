import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuditEntry, AuditLog } from '@auto-wp/contracts';
import { canonicalJson, sha256Hex } from './canonical.js';

const GENESIS = '0'.repeat(64);
const SENSITIVE_KEY = /pass|pwd|secret|token|key|auth|cookie|credential|nonce/i;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^/\s@]*@/gi;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string') return value.replace(URL_CREDENTIALS, '$1[REDACTED]@');
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}

/** The entry is nested so payload fields can never collide with the chain envelope. */
interface ChainedLine {
  seq: number;
  prevHash: string;
  hash: string;
  entry: AuditEntry;
}

const computeHash = (prevHash: string, seq: number, entry: AuditEntry): string =>
  sha256Hex(prevHash + canonicalJson({ entry, seq }));

export class FileAuditLog implements AuditLog {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  private state: { seq: number; hash: string } | undefined;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'audit.jsonl');
  }

  append(e: AuditEntry): Promise<void> {
    const run = this.queue.then(() => this.doAppend(e));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doAppend(e: AuditEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.state ??= await this.loadState();
    const entry: AuditEntry = { ...e };
    if (e.data !== undefined) entry.data = redact(e.data);
    const seq = this.state.seq + 1;
    const prevHash = this.state.hash;
    const hash = computeHash(prevHash, seq, entry);
    const line = `${JSON.stringify({ seq, prevHash, hash, entry })}\n`;
    let fh: FileHandle | undefined;
    try {
      fh = await open(this.path, 'a');
      await fh.appendFile(line);
      await fh.sync();
    } finally {
      await fh?.close();
    }
    this.state = { seq, hash };
  }

  private async loadState(): Promise<{ seq: number; hash: string }> {
    const lines = await this.readLines();
    const last = lines.at(-1);
    if (!last) return { seq: 0, hash: GENESIS };
    const parsed = JSON.parse(last) as ChainedLine;
    return { seq: parsed.seq, hash: parsed.hash };
  }

  private async readLines(): Promise<string[]> {
    try {
      return (await readFile(this.path, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async tail(limit: number): Promise<AuditEntry[]> {
    await this.queue;
    if (limit <= 0) return [];
    const lines = (await this.readLines()).slice(-limit);
    return lines.map((l) => (JSON.parse(l) as ChainedLine).entry);
  }

  async verifyChain(): Promise<{ ok: boolean; brokenAtSeq?: number }> {
    await this.queue;
    const lines = await this.readLines();
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const line of lines) {
      let parsed: ChainedLine;
      try {
        parsed = JSON.parse(line) as ChainedLine;
      } catch {
        return { ok: false, brokenAtSeq: expectedSeq };
      }
      const { prevHash, hash, entry, seq } = parsed;
      if (seq !== expectedSeq || prevHash !== prev || !entry || computeHash(prevHash, seq, entry) !== hash) {
        return { ok: false, brokenAtSeq: expectedSeq };
      }
      prev = hash;
      expectedSeq++;
    }
    return { ok: true };
  }
}

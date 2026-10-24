import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuditEntry, AuditLog } from '@auto-wp/contracts';
import { canonicalJson, sha256Hex } from './canonical.js';

const GENESIS = '0'.repeat(64);
const SENSITIVE_KEY = /password|secret|token|key/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}

interface ChainedLine extends AuditEntry {
  seq: number;
  prevHash: string;
  hash: string;
}

const computeHash = (prevHash: string, body: object): string => sha256Hex(prevHash + canonicalJson(body));

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
    const hash = computeHash(prevHash, { ...entry, seq });
    const line = `${JSON.stringify({ ...entry, seq, prevHash, hash })}\n`;
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
    return lines.map((l) => {
      const { seq: _s, prevHash: _p, hash: _h, ...entry } = JSON.parse(l) as ChainedLine;
      return entry;
    });
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
      const { prevHash, hash, ...body } = parsed;
      if (parsed.seq !== expectedSeq || prevHash !== prev || computeHash(prevHash, body) !== hash) {
        return { ok: false, brokenAtSeq: expectedSeq };
      }
      prev = hash;
      expectedSeq++;
    }
    return { ok: true };
  }
}

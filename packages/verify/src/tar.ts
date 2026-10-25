import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

export interface TarWalkResult {
  /** Entries excluding pax/GNU metadata pseudo-entries. */
  entries: number;
  /** Regular files (typeflag `0`, NUL or `7`). */
  files: number;
  /** True when the two-zero-block end marker was seen. */
  endMarker: boolean;
}

const BLOCK = 512;

function parseNumber(b: Buffer, start: number, len: number): number {
  const first = b[start] ?? 0;
  if (first & 0x80) {
    // GNU base-256 encoding for large values.
    let v = first & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + (b[start + i] ?? 0);
    return v;
  }
  const txt = b
    .subarray(start, start + len)
    .toString('latin1')
    .replace(/\0.*$/s, '')
    .trim();
  if (txt === '') return 0;
  if (!/^[0-7]+$/.test(txt)) throw new Error(`invalid tar numeric field "${txt}"`);
  return Number.parseInt(txt, 8);
}

/** Streaming tar header walker. Validates header checksums; never holds more than one header block. */
export class TarWalker {
  private readonly hdr = Buffer.alloc(BLOCK);
  private hlen = 0;
  private skip = 0;
  private zeroBlocks = 0;
  private ended = false;
  private entries = 0;
  private files = 0;

  write(chunk: Buffer): void {
    let off = 0;
    while (off < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - off);
        this.skip -= n;
        off += n;
        continue;
      }
      const n = Math.min(BLOCK - this.hlen, chunk.length - off);
      chunk.copy(this.hdr, this.hlen, off, off + n);
      this.hlen += n;
      off += n;
      if (this.hlen === BLOCK) {
        this.hlen = 0;
        this.header();
      }
    }
  }

  private header(): void {
    if (this.ended) return;
    const h = this.hdr;
    if (h.every((x) => x === 0)) {
      if (++this.zeroBlocks >= 2) this.ended = true;
      return;
    }
    this.zeroBlocks = 0;
    const stored = parseNumber(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] ?? 0);
    if (sum !== stored) throw new Error(`bad tar header checksum at entry ${this.entries + 1}`);
    const size = parseNumber(h, 124, 12);
    const type = String.fromCharCode(h[156] ?? 0);
    // pax (x, g) and GNU long name/link (L, K) records describe the next entry; they are not entries.
    if (!'xgLK'.includes(type)) {
      this.entries++;
      if (type === '0' || type === '\0' || type === '7') this.files++;
    }
    this.skip = Math.ceil(size / BLOCK) * BLOCK;
  }

  finish(): TarWalkResult {
    if (this.hlen > 0 || this.skip > 0) throw new Error('tar archive truncated mid-entry');
    return { entries: this.entries, files: this.files, endMarker: this.ended };
  }
}

/** Gunzip and walk a .tar.gz stream. Rejects on corrupt gzip, bad headers or truncation. */
export async function walkTarGz(source: Readable | NodeJS.ReadableStream): Promise<TarWalkResult> {
  const walker = new TarWalker();
  await pipeline(source as Readable, createGunzip(), async (decoded: AsyncIterable<Buffer>) => {
    for await (const chunk of decoded) walker.write(chunk);
  });
  return walker.finish();
}

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DOWNLOAD_CHUNK, UPLOAD_CHUNK } from '../src/index.js';
import { json, makeConn, startServer } from './helpers.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Tiny in-memory agent filesystem. */
async function fsServer(opts: { corrupt?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const log: string[] = [];
  const s = await startServer((r, res) => {
    const { action, params: p } = JSON.parse(r.body);
    log.push(action);
    switch (action) {
      case 'fs.readChunk': {
        const f = files.get(p.path);
        if (!f) return json(res, { ok: false, error: { code: 'not_found', message: 'nf' } }, 400);
        const part = f.subarray(p.offset, p.offset + p.length);
        return json(res, {
          ok: true,
          result: { dataB64: part.toString('base64'), eof: p.offset + p.length >= f.length, size: f.length },
        });
      }
      case 'fs.writeChunk': {
        const cur = p.truncate ? Buffer.alloc(0) : (files.get(p.path) ?? Buffer.alloc(0));
        let d = Buffer.from(p.dataB64, 'base64');
        const n = d.length;
        if (opts.corrupt && d.length) d = Buffer.concat([Buffer.from([(d[0] ?? 0) ^ 1]), d.subarray(1)]);
        files.set(p.path, Buffer.concat([cur.subarray(0, p.offset), d]));
        return json(res, { ok: true, result: { bytesWritten: n } });
      }
      case 'fs.sha256': {
        const f = files.get(p.path) ?? Buffer.alloc(0);
        return json(res, {
          ok: true,
          result: { sha256: createHash('sha256').update(f).digest('hex'), bytes: f.length },
        });
      }
      case 'fs.rename': {
        files.set(p.to, files.get(p.from) ?? Buffer.alloc(0));
        files.delete(p.from);
        return json(res, { ok: true, result: {} });
      }
      case 'fs.remove':
        files.delete(p.path);
        return json(res, { ok: true, result: {} });
      default:
        return json(res, { ok: true, result: {} });
    }
  });
  servers.push(s);
  return { s, files, log };
}

describe('download / readFile', () => {
  for (const size of [0, 1, DOWNLOAD_CHUNK - 1, DOWNLOAD_CHUNK, DOWNLOAD_CHUNK + 1, 2 * DOWNLOAD_CHUNK + 5]) {
    it(`reads ${size} bytes across chunk boundaries`, async () => {
      const { s, files } = await fsServer();
      const data = randomBytes(size);
      files.set('f.bin', data);
      const { conn } = makeConn({ endpoint: s.url });
      expect((await conn.readFile('f.bin')).equals(data)).toBe(true);
    });
  }

  it('download is lazy and honours offset', async () => {
    const { s, files } = await fsServer();
    const data = randomBytes(DOWNLOAD_CHUNK + 100);
    files.set('f.bin', data);
    const { conn } = makeConn({ endpoint: s.url });
    const stream = await conn.download('f.bin', { offset: 50 });
    expect(s.reqs).toHaveLength(0);
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(c as Buffer);
    expect(Buffer.concat(parts).equals(data.subarray(50))).toBe(true);
    const offsets = s.reqs.map((r) => JSON.parse(r.body).params.offset);
    expect(offsets).toEqual([50, 50 + DOWNLOAD_CHUNK]);
  });
});

describe('writeFile', () => {
  it('chunks uploads, verifies sha, and renames atomically', async () => {
    const { s, files, log } = await fsServer();
    const data = randomBytes(2 * UPLOAD_CHUNK + 7);
    const { conn } = makeConn({ endpoint: s.url });
    await conn.writeFile('wp-content/x.bin', data, { mode: 0o644 });
    expect(files.get('wp-content/x.bin')?.equals(data)).toBe(true);
    expect([...files.keys()]).toEqual(['wp-content/x.bin']);
    expect(log).toEqual(['fs.writeChunk', 'fs.writeChunk', 'fs.writeChunk', 'fs.sha256', 'fs.rename']);
    const writes = s.reqs.map((r) => JSON.parse(r.body)).filter((b) => b.action === 'fs.writeChunk');
    expect(writes.map((w) => [w.params.offset, w.params.truncate])).toEqual([
      [0, true],
      [UPLOAD_CHUNK, false],
      [2 * UPLOAD_CHUNK, false],
    ]);
    expect(writes[0].params.path).toMatch(/^wp-content\/x\.bin\.tmp-[0-9a-f]+$/);
    expect(writes[0].params.mode).toBe(0o644);
  });

  it('writes empty and string content, non-atomic directly', async () => {
    const { s, files } = await fsServer();
    const { conn } = makeConn({ endpoint: s.url });
    await conn.writeFile('e', Buffer.alloc(0), { atomic: false });
    await conn.writeFile('s', 'héllo', { atomic: false });
    expect(files.get('e')?.length).toBe(0);
    expect(files.get('s')?.toString()).toBe('héllo');
  });

  it('refuses on sha mismatch and cleans up the temp file', async () => {
    const { s, files, log } = await fsServer({ corrupt: true });
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.writeFile('x.bin', Buffer.from('hello world'))).rejects.toThrow(/sha256 mismatch/);
    expect(files.size).toBe(0);
    expect(log).not.toContain('fs.rename');
    expect(log.at(-1)).toBe('fs.remove');
  });
});

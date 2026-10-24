import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAuditLog } from '../src/index.js';

const entry = (action: string, data?: unknown) => ({
  ts: '2026-01-01T00:00:00Z',
  actor: 't',
  action,
  dryRun: false,
  data,
});
const dir = () => mkdtemp(join(tmpdir(), 'audit-'));

describe('FileAuditLog', () => {
  it('appends, tails and verifies', async () => {
    const log = new FileAuditLog(await dir());
    for (let i = 0; i < 5; i++) await log.append(entry(`a${i}`));
    expect((await log.tail(2)).map((e) => e.action)).toEqual(['a3', 'a4']);
    expect(await log.verifyChain()).toEqual({ ok: true });
  });

  it('detects tampering at the right seq', async () => {
    const d = await dir();
    const log = new FileAuditLog(d);
    for (let i = 0; i < 5; i++) await log.append(entry(`a${i}`));
    const lines = (await readFile(log.path, 'utf8')).trim().split('\n');
    lines[2] = (lines[2] as string).replace('"a2"', '"evil"');
    await writeFile(log.path, `${lines.join('\n')}\n`);
    expect(await new FileAuditLog(d).verifyChain()).toEqual({ ok: false, brokenAtSeq: 3 });
  });

  it('detects deleted lines', async () => {
    const d = await dir();
    const log = new FileAuditLog(d);
    for (let i = 0; i < 4; i++) await log.append(entry(`a${i}`));
    const lines = (await readFile(log.path, 'utf8')).trim().split('\n');
    lines.splice(1, 1);
    await writeFile(log.path, `${lines.join('\n')}\n`);
    expect(await log.verifyChain()).toEqual({ ok: false, brokenAtSeq: 2 });
  });

  it('keeps the chain valid under concurrent appends and across instances', async () => {
    const d = await dir();
    const log = new FileAuditLog(d);
    await Promise.all(Array.from({ length: 50 }, (_, i) => log.append(entry(`c${i}`))));
    expect(await log.verifyChain()).toEqual({ ok: true });
    const again = new FileAuditLog(d);
    await again.append(entry('later'));
    expect(await again.verifyChain()).toEqual({ ok: true });
    expect(await again.tail(100)).toHaveLength(51);
  });

  it('redacts sensitive keys', async () => {
    const log = new FileAuditLog(await dir());
    await log.append(
      entry('x', {
        password: 'pw-val',
        nested: { apiKey: 'k-val', API_TOKEN: 't-val', client_secret: 's-val', ok: 1 },
        list: [{ token: 'z-val' }],
      }),
    );
    const raw = await readFile(log.path, 'utf8');
    for (const s of ['pw-val', 'k-val', 't-val', 's-val', 'z-val']) expect(raw).not.toContain(s);
    expect((await log.tail(1))[0]?.data).toEqual({
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', API_TOKEN: '[REDACTED]', client_secret: '[REDACTED]', ok: 1 },
      list: [{ token: '[REDACTED]' }],
    });
    expect(await log.verifyChain()).toEqual({ ok: true });
  });
});

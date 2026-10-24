import { PassThrough } from 'node:stream';
import type { ApprovalRequest } from '@auto-wp/contracts';
import { FakeClock, MemoryLogger } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import {
  ApprovalLedger,
  canonicalJson,
  ElicitationApprovalGate,
  EnvApprovalGate,
  planHash,
  TtyApprovalGate,
} from '../src/index.js';

const req = (): ApprovalRequest => ({
  action: 'restore.execute',
  siteId: 's1',
  summary: 'restore it',
  planHash: planHash({ a: 1 }),
});

describe('planHash', () => {
  it('is stable across key order', () => {
    expect(planHash({ a: 1, b: { c: [1, { y: 1, x: 2 }], d: 2 } })).toBe(
      planHash({ b: { d: 2, c: [1, { x: 2, y: 1 }] }, a: 1 }),
    );
    expect(canonicalJson({ b: 1, 10: 1, 2: 1 })).toBe('{"10":1,"2":1,"b":1}');
    expect(() => planHash(undefined)).not.toThrow();
    expect(planHash({ a: 1 })).not.toBe(planHash({ a: 2 }));
    expect(planHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ElicitationApprovalGate', () => {
  const code = req().planHash.slice(0, 8);
  it('approves on accept with correct code', async () => {
    const gate = new ElicitationApprovalGate(async (msg) => {
      expect(msg).toContain(code);
      return { action: 'accept', content: { confirmation: code.toUpperCase() } };
    });
    expect((await gate.request(req())).approved).toBe(true);
  });
  it('denies decline, cancel and wrong code', async () => {
    for (const r of [
      { action: 'decline' as const },
      { action: 'cancel' as const },
      { action: 'accept' as const, content: { confirmation: 'deadbeef' } },
      { action: 'accept' as const },
      { action: 'decline' as const, content: { confirmation: code } },
    ]) {
      expect((await new ElicitationApprovalGate(async () => r).request(req())).approved).toBe(false);
    }
  });
});

describe('TtyApprovalGate', () => {
  const run = async (answer: string | null) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const gate = new TtyApprovalGate(() => ({ input, output }));
    const p = gate.request(req());
    setImmediate(() => (answer === null ? input.end() : input.write(`${answer}\n`)));
    return p;
  };
  it('approves with the code', async () => {
    expect((await run(req().planHash.slice(0, 8))).approved).toBe(true);
  });
  it('denies otherwise', async () => {
    expect((await run('yes')).approved).toBe(false);
    expect((await run(null)).approved).toBe(false);
  });
});

describe('EnvApprovalGate', () => {
  it('approves only with env flag and warns', async () => {
    const log = new MemoryLogger();
    expect((await new EnvApprovalGate(log, { AUTOWP_TEST_APPROVE: '1' }).request(req())).approved).toBe(true);
    expect((await new EnvApprovalGate(log, {}).request(req())).approved).toBe(false);
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
});

describe('ApprovalLedger', () => {
  const ok = (h: string) => ({ approved: true, by: 't', planHash: h, at: '' });
  it('is single use', () => {
    const l = new ApprovalLedger(new FakeClock());
    l.record(ok('h1'));
    expect(l.consume('h1').approved).toBe(true);
    expect(() => l.consume('h1')).toThrow();
  });
  it('rejects mismatched hash and keeps the real approval', () => {
    const l = new ApprovalLedger(new FakeClock());
    l.record(ok('h1'));
    expect(() => l.consume('h2')).toThrow(/no approval/);
    expect(l.consume('h1').approved).toBe(true);
  });
  it('expires after ttl', () => {
    const c = new FakeClock();
    const l = new ApprovalLedger(c);
    l.record(ok('h1'));
    c.advance(15 * 60_000);
    expect(() => l.consume('h1')).toThrow(/expired/);
    l.record(ok('h2'));
    c.advance(15 * 60_000 - 1);
    expect(l.consume('h2').approved).toBe(true);
  });
  it('ignores denials', () => {
    const l = new ApprovalLedger(new FakeClock());
    l.record({ ...ok('h1'), approved: false });
    expect(() => l.consume('h1')).toThrow();
  });
  it('cannot re-record a consumed approval', () => {
    const l = new ApprovalLedger(new FakeClock());
    l.record(ok('h1'));
    l.consume('h1');
    expect(() => l.record(ok('h1'))).toThrow(/already consumed/);
    expect(() => l.consume('h1')).toThrow();
  });
  it('counts the ttl from the approval time and does not refresh on re-record', () => {
    const c = new FakeClock('2026-01-01T01:00:00Z');
    const l = new ApprovalLedger(c);
    l.record({ ...ok('old'), at: '2026-01-01T00:00:00Z' });
    expect(() => l.consume('old')).toThrow(/expired/);
    l.record({ ...ok('h'), at: c.now().toISOString() });
    c.advance(10 * 60_000);
    l.record({ ...ok('h'), at: c.now().toISOString() });
    c.advance(5 * 60_000);
    expect(() => l.consume('h')).toThrow(/expired/);
  });
});

import { describe, expect, it } from 'vitest';
import { inRange, versionCompare } from '../src/version.js';
import fixture from './fixtures/version-compare.json' with { type: 'json' };

describe('versionCompare parity with PHP version_compare', () => {
  for (const c of fixture) {
    it(`${JSON.stringify(c.a)} vs ${JSON.stringify(c.b)} = ${c.expected}`, () => {
      expect(versionCompare(c.a, c.b)).toBe(c.expected);
    });
  }
});

describe('inRange', () => {
  const r = (from: string, fi: boolean, to: string, ti: boolean) => ({
    from,
    fromInclusive: fi,
    to,
    toInclusive: ti,
  });
  it('handles wildcards', () => {
    expect(inRange('99.0', r('*', true, '*', true))).toBe(true);
    expect(inRange('1.0', r('*', true, '5.8.4', false))).toBe(true);
    expect(inRange('5.8.4', r('*', true, '5.8.4', false))).toBe(false);
    expect(inRange('5.8.4', r('*', true, '5.8.4', true))).toBe(true);
    expect(inRange('5.8.5', r('5.8.4', false, '*', true))).toBe(true);
  });
  it('respects bound inclusivity', () => {
    expect(inRange('2.0', r('2.0', true, '3.0', false))).toBe(true);
    expect(inRange('2.0', r('2.0', false, '3.0', false))).toBe(false);
    expect(inRange('3.0', r('2.0', true, '3.0', true))).toBe(true);
    expect(inRange('3.0.0', r('2.0', true, '3.0', false))).toBe(false);
  });
  it('treats pre-releases as older than the release', () => {
    expect(inRange('6.6-RC1', r('*', true, '6.6', false))).toBe(true);
  });
});

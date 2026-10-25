import { describe, expect, it } from 'vitest';
import { isMajorChange, sourceOf } from '../src/item.js';

describe('isMajorChange', () => {
  it.each([
    ['core', '6.6.2', '6.7', true],
    ['core', '6.6.1', '6.6.2', false],
    ['core', '5.9.3', '6.0', true],
    ['core', '6.7', '6.7.1', false],
    ['core', '6.7.0', '6.7.1', false],
    ['plugin', '1.9.9', '2.0', true],
    ['plugin', '1.2', '1.10', false],
    ['plugin', '0.9', '1.0', true],
    ['plugin', '10.1', '10.2', false],
    ['theme', '3.0.0', '4.0.0', true],
    ['theme', '3.0.0', '3.0.1', false],
  ] as const)('%s %s -> %s major=%s', (type, from, to, major) => {
    expect(isMajorChange(type, from, to)).toBe(major);
  });
});

describe('sourceOf', () => {
  it('classifies by package host', () => {
    expect(sourceOf('https://downloads.wordpress.org/plugin/akismet.5.4.zip')).toBe('wporg');
    expect(sourceOf('https://vendor.example/addon.zip')).toBe('premium');
    expect(sourceOf(undefined)).toBe('unknown');
    expect(sourceOf('not a url')).toBe('unknown');
  });
});

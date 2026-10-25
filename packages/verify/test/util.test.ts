import { describe, expect, it } from 'vitest';
import { TarWalker } from '../src/tar.js';
import { DEFAULT_FILE_TOLERANCE, isVolatileTable, withinTolerance } from '../src/util.js';
import { buildTar } from './helpers.js';

describe('withinTolerance', () => {
  it('uses max(abs, pct * expected)', () => {
    expect(withinTolerance(100, 105, DEFAULT_FILE_TOLERANCE)).toBe(true); // abs 5
    expect(withinTolerance(100, 106, DEFAULT_FILE_TOLERANCE)).toBe(false);
    expect(withinTolerance(10_000, 10_050, DEFAULT_FILE_TOLERANCE)).toBe(true); // 0.5% = 50
    expect(withinTolerance(10_000, 10_051, DEFAULT_FILE_TOLERANCE)).toBe(false);
    expect(withinTolerance(10_000, 9_950, DEFAULT_FILE_TOLERANCE)).toBe(true);
    expect(withinTolerance(0, 5, DEFAULT_FILE_TOLERANCE)).toBe(true);
    expect(withinTolerance(0, 6, DEFAULT_FILE_TOLERANCE)).toBe(false);
  });
});

describe('isVolatileTable', () => {
  it('matches known volatile suffixes and custom patterns', () => {
    for (const n of [
      'wp_wc_sessions',
      'wp_sessions',
      'wp_actionscheduler_logs',
      'wp_wfLiveTraffic',
      'wp_wflogs',
      'wp_statistics_visitor',
      'wp_yoast_indexable',
    ])
      expect(isVolatileTable(n), n).toBe(true);
    for (const n of ['wp_posts', 'wp_options', 'wp_actionscheduler_actions', 'wp_usermeta'])
      expect(isVolatileTable(n), n).toBe(false);
    expect(isVolatileTable('wp_posts', [/_posts$/])).toBe(true);
  });
});

describe('TarWalker', () => {
  it('counts regular files, ignores dirs and pax records, validates the end marker', () => {
    const tar = buildTar([
      { name: 'd/', type: '5' },
      { name: 'PaxHeader', type: 'x', data: '' },
      { name: 'd/a', data: 'hello' },
      { name: 'd/b', data: 'x'.repeat(1000) },
      { name: 'link', type: '2' },
    ]);
    for (const size of [1, 7, 512, 100_000]) {
      const w = new TarWalker();
      for (let i = 0; i < tar.length; i += size) w.write(tar.subarray(i, i + size));
      expect(w.finish()).toEqual({ entries: 4, files: 2, endMarker: true });
    }
  });

  it('rejects truncation and corrupted headers', () => {
    const tar = buildTar([{ name: 'a', data: 'x'.repeat(2000) }]);
    const t = new TarWalker();
    t.write(tar.subarray(0, 1000));
    expect(() => t.finish()).toThrow(/truncated/);
    const bad = Buffer.from(tar);
    bad[3] = (bad[3] ?? 0) ^ 0xff;
    expect(() => new TarWalker().write(bad)).toThrow(/checksum/);
  });
});

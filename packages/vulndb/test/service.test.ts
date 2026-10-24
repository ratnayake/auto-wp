import type { ItemType, UpdateItem, Vulnerability, VulnProvider } from '@auto-wp/contracts';
import { describe, expect, it } from 'vitest';
import { PatchstackProvider } from '../src/patchstack.js';
import { DefaultVulnService, WORDFENCE_ATTRIBUTION, WPSCAN_ATTRIBUTION } from '../src/service.js';

const item = (over: Partial<UpdateItem> = {}): UpdateItem => ({
  type: 'plugin',
  slug: 'contact-form-7',
  name: 'Contact Form 7',
  currentVersion: '5.8.3',
  newVersion: '5.8.4',
  active: true,
  source: 'wporg',
  isMajor: false,
  ...over,
});

const vuln = (over: Partial<Vulnerability> = {}): Vulnerability => ({
  id: 'x',
  source: 'wordfence',
  title: 'Thing',
  affected: [{ from: '*', fromInclusive: true, to: '5.8.4', toInclusive: false }],
  references: [],
  ...over,
});

const provider = (
  name: VulnProvider['name'],
  fn: (t: ItemType, s: string) => Promise<Vulnerability[]>,
): VulnProvider & { calls: number } => {
  const p = {
    name,
    calls: 0,
    lookup(t: ItemType, s: string) {
      p.calls++;
      return fn(t, s);
    },
  };
  return p;
};

describe('DefaultVulnService', () => {
  it('splits old vs new affecting', async () => {
    const wf = provider('wordfence', async () => [
      vuln({ id: '1', cve: 'CVE-1' }),
      vuln({
        id: '2',
        title: 'Also in 5.8.4',
        affected: [{ from: '*', fromInclusive: true, to: '5.9', toInclusive: false }],
      }),
      vuln({
        id: '3',
        title: 'Old only',
        affected: [{ from: '*', fromInclusive: true, to: '5.8.3', toInclusive: true }],
      }),
      vuln({
        id: '4',
        title: 'Unrelated',
        affected: [{ from: '6.0', fromInclusive: true, to: '*', toInclusive: true }],
      }),
    ]);
    const [a] = await new DefaultVulnService([wf]).assess([item()]);
    expect(a?.affectingOld.map((v) => v.id)).toEqual(['1', '2', '3']);
    expect(a?.stillAffectingNew.map((v) => v.id)).toEqual(['2']);
    expect(a?.sources).toEqual(['wordfence']);
    expect(a?.errors).toEqual([]);
  });

  it('falls back on 5xx/unavailable but not on an empty result', async () => {
    const down = provider('wordfence', async () => {
      throw new Error('Wordfence feed unavailable: HTTP 503');
    });
    const ws = provider('wpscan', async () => [vuln({ source: 'wpscan', id: 'w' })]);
    const svc = new DefaultVulnService([down, ws]);
    const [a] = await svc.assess([item()]);
    expect(a?.sources).toEqual(['wpscan']);
    expect(a?.errors).toEqual(['wordfence: Wordfence feed unavailable: HTTP 503']);
    expect(a?.affectingOld).toHaveLength(1);

    const empty = provider('wordfence', async () => []);
    const ws2 = provider('wpscan', async () => [vuln()]);
    const [b] = await new DefaultVulnService([empty, ws2]).assess([item()]);
    expect(ws2.calls).toBe(0);
    expect(b?.affectingOld).toEqual([]);
    expect(b?.sources).toEqual(['wordfence']);
  });

  it('reports errors for every provider when all fail', async () => {
    const bad = (n: 'wordfence' | 'wpscan') =>
      provider(n, async () => {
        throw new Error('boom');
      });
    const svc = new DefaultVulnService([bad('wordfence'), bad('wpscan'), new PatchstackProvider()]);
    const [a] = await svc.assess([item()]);
    expect(a?.sources).toEqual([]);
    expect(a?.errors).toHaveLength(3);
    expect(a?.errors[2]).toMatch(/not configured/);
    expect(svc.attributions()).toEqual([]);
  });

  it('dedupes by CVE; title-only merges need identical ranges', async () => {
    const r = (to: string) => [{ from: '*', fromInclusive: true, to, toInclusive: false }];
    const wf = provider('wordfence', async () => [
      vuln({
        id: '1',
        cve: 'CVE-2024-1',
        title: 'A',
        fixedIn: '5.8.4',
        cvss: { score: 5, rating: 'Medium' },
      }),
      vuln({
        id: '2',
        cve: 'cve-2024-1',
        title: 'B',
        fixedIn: '5.9.1',
        cvss: { score: 9, rating: 'Critical' },
        affected: [{ from: '7', fromInclusive: true, to: '8', toInclusive: true }],
      }),
      vuln({ id: '3', title: 'Cross-Site  Scripting!', affected: r('5.9') }),
      vuln({ id: '4', title: 'cross site scripting', affected: r('5.9') }),
      vuln({ id: '5', title: 'Cross Site Scripting', affected: r('5.9.5') }),
      vuln({ id: '6', title: 'Different', affected: r('5.9') }),
    ]);
    const [a] = await new DefaultVulnService([wf]).assess([item()]);
    expect(a?.affectingOld.map((v) => v.id)).toEqual(['1', '3', '5', '6']);
    expect(a?.affectingOld[0]).toMatchObject({ fixedIn: '5.9.1', cvss: { score: 9 } });
    expect(a?.affectingOld[0]?.affected).toHaveLength(2);
  });

  it('surfaces stale Wordfence data in errors and sets lookupFailed', async () => {
    const stale = Object.assign(
      provider('wordfence', async () => []),
      { staleNotice: () => 'using stale Wordfence data from 2026-01-01' },
    );
    const [a] = await new DefaultVulnService([stale]).assess([item()]);
    expect(a?.errors).toEqual(['wordfence: using stale Wordfence data from 2026-01-01']);
    expect(a?.lookupFailed).toEqual({ old: false, new: false });
    const down = provider('wordfence', async () => {
      throw new Error('x');
    });
    const [b] = await new DefaultVulnService([down]).assess([item()]);
    expect(b?.lookupFailed).toEqual({ old: true, new: true });
  });

  it('returns attributions only for providers used', async () => {
    const wf = provider('wordfence', async () => []);
    const ws = provider('wpscan', async () => []);
    const svc = new DefaultVulnService([wf, ws]);
    expect(svc.attributions()).toEqual([]);
    await svc.assess([item()]);
    expect(svc.attributions()).toEqual([WORDFENCE_ATTRIBUTION]);
    expect(WORDFENCE_ATTRIBUTION).toContain('https://www.wordfence.com/threat-intel/');
    expect(WPSCAN_ATTRIBUTION).toContain('WPScan');
  });

  it('end-to-end over fixture ranges: wordpress core < 6.5.5', async () => {
    const wf = provider('wordfence', async () => [
      vuln({
        title: 'Core XSS',
        affected: [
          { from: '6.5', fromInclusive: true, to: '6.5.4', toInclusive: true },
          { from: '*', fromInclusive: true, to: '6.4.4', toInclusive: true },
        ],
      }),
    ]);
    const [a] = await new DefaultVulnService([wf]).assess([
      item({ type: 'core', slug: 'wordpress', currentVersion: '6.5.4', newVersion: '6.5.5' }),
    ]);
    expect(a?.affectingOld).toHaveLength(1);
    expect(a?.stillAffectingNew).toHaveLength(0);
  });
});

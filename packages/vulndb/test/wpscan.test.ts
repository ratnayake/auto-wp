import { FakeClock } from '@auto-wp/contracts/fakes';
import { afterEach, describe, expect, it } from 'vitest';
import { QuotaExceededError } from '../src/errors.js';
import { WpscanProvider } from '../src/wpscan.js';
import { startServer, type TestServer, tmpCache } from './helpers.js';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const body = {
  'contact-form-7': {
    friendly_name: 'Contact Form 7',
    vulnerabilities: [
      {
        id: 1,
        title: 'CF7 <= 5.8.3 - File Upload',
        fixed_in: '5.8.4',
        references: { cve: ['2023-6449'], url: ['https://example.org/1'] },
        cvss: { score: '9.8', severity: 'critical', vector: 'CVSS:3.1/AV:N' },
      },
      { id: 2, title: 'CF7 - Unfixed thing', fixed_in: null, references: { url: [] } },
    ],
  },
};

async function setup(limit = 25) {
  srv = await startServer((req, res) => {
    if (req.url === '/api/v3/plugins/missing') return void res.writeHead(404).end();
    if (req.url?.startsWith('/api/v3/wordpresses/')) {
      res
        .writeHead(200)
        .end(
          JSON.stringify({ '655': { vulnerabilities: [{ id: 9, title: 'Core thing', fixed_in: '6.5.5' }] } }),
        );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  const cacheDir = await tmpCache();
  const clock = new FakeClock('2026-03-01T10:00:00Z');
  const mk = () =>
    new WpscanProvider({ token: 'tok', cacheDir, clock, baseUrl: `${srv?.url}/api/v3/`, dailyLimit: limit });
  return { mk, clock, s: srv };
}

describe('WpscanProvider', () => {
  it('maps vulnerabilities and sends the token header', async () => {
    const { mk, s } = await setup();
    const r = await mk().lookup('plugin', 'contact-form-7');
    expect(s.requests[0]?.headers.authorization).toBe('Token token=tok');
    expect(r[0]).toMatchObject({
      source: 'wpscan',
      cve: 'CVE-2023-6449',
      fixedIn: '5.8.4',
      cvss: { score: 9.8, rating: 'critical' },
      affected: [{ from: '*', fromInclusive: true, to: '5.8.4', toInclusive: false }],
      references: ['https://example.org/1'],
    });
    expect(r[1]?.fixedIn).toBeUndefined();
    expect(r[1]?.affected).toEqual([{ from: '*', fromInclusive: true, to: '*', toInclusive: true }]);
  });

  it('uses dotless version for core and caches per path for 24h', async () => {
    const { mk, s, clock } = await setup();
    await mk().lookup('core', 'wordpress', { versions: ['6.5.4', '6.5.5'] });
    expect(s.requests.map((r) => r.url)).toEqual(['/api/v3/wordpresses/654', '/api/v3/wordpresses/655']);
    await mk().lookup('core', 'wordpress', { versions: ['6.5.4'] });
    expect(s.requests).toHaveLength(2);
    clock.advance(25 * 3600_000);
    await mk().lookup('core', 'wordpress', { versions: ['6.5.4'] });
    expect(s.requests).toHaveLength(3);
  });

  it('treats 404 as no vulnerabilities', async () => {
    const { mk } = await setup();
    expect(await mk().lookup('plugin', 'missing')).toEqual([]);
  });

  it('enforces a persisted daily quota that resets next day; cache hits are free', async () => {
    const { mk, clock, s } = await setup(2);
    await mk().lookup('plugin', 'a');
    await mk().lookup('plugin', 'a'); // cached, free
    await mk().lookup('plugin', 'b');
    await expect(mk().lookup('plugin', 'c')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(s.requests).toHaveLength(2);
    clock.advance(24 * 3600_000);
    await expect(mk().lookup('plugin', 'c')).resolves.toBeDefined();
  });
});

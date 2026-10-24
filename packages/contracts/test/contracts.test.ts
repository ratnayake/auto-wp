import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeSiteConnection } from '../src/fakes/index.js';
import {
  ACTION_NAMES,
  AppConfigSchema,
  actionSchemas,
  canonicalString,
  PathJailError,
  SiteConfigSchema,
  TOOL_NAMES,
} from '../src/index.js';
import vectors from '../test-vectors.json' with { type: 'json' };

describe('protocol test vectors', () => {
  const pub = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(vectors.ed25519.publicKeyB64, 'base64'),
    ]),
    format: 'der',
    type: 'spki',
  });

  it.each(vectors.requests)('canonical string and signature for $name', (v) => {
    expect(canonicalString(v)).toBe(v.canonical);
    expect(verify(null, Buffer.from(v.canonical), pub, Buffer.from(v.ed25519SignatureB64, 'base64'))).toBe(
      true,
    );
  });

  it('seed derives the published public key', () => {
    const seed = Buffer.from(vectors.ed25519.seedB64, 'base64');
    const priv = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const derived = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
    expect(Buffer.from(derived).toString('base64')).toBe(vectors.ed25519.publicKeyB64);
  });
});

describe('catalogues', () => {
  it('tool names are valid Claude tool names', () => {
    for (const n of TOOL_NAMES) expect(n).toMatch(/^[a-z_]{1,64}$/);
  });
  it('every action has params and result schemas', () => {
    for (const a of ACTION_NAMES) {
      expect(actionSchemas[a].params).toBeDefined();
      expect(actionSchemas[a].result).toBeDefined();
    }
  });
});

describe('config schemas', () => {
  it('applies defaults', () => {
    const site = SiteConfigSchema.parse({
      id: 'site-ssh',
      name: 'Demo',
      url: 'https://example.com',
      transport: {
        kind: 'ssh',
        host: 'example.com',
        username: 'cp',
        hostKeySha256: 'SHA256:abc=',
        wpRoot: '/home/cp/public_html',
      },
    });
    expect(site.backupLocation).toBe('docroot');
    expect(site.transport.kind === 'ssh' && site.transport.port).toBe(22);
    expect(AppConfigSchema.parse({ sites: [site] }).policy.backupMaxAgeMinutes).toBe(60);
  });
});

describe('FakeSiteConnection', () => {
  it('jails paths and stores files', async () => {
    const c = new FakeSiteConnection().seed({ 'wp-config.php': '<?php' });
    expect((await c.readFile('/var/www/html/wp-config.php')).toString()).toBe('<?php');
    await expect(c.readFile('../../etc/passwd')).rejects.toBeInstanceOf(PathJailError);
    expect((await c.list('.')).map((s) => s.path)).toEqual(['/var/www/html/wp-config.php']);
  });
  it('injects failures and scripts actions', async () => {
    const c = new FakeSiteConnection().onCall('lock.acquire', () => ({ acquired: true }));
    c.failNext('call:lock.acquire');
    await expect(c.call('lock.acquire', { runId: 'r' })).rejects.toThrow('injected');
    await expect(c.call('lock.acquire', { runId: 'r' })).resolves.toEqual({ acquired: true });
  });
});

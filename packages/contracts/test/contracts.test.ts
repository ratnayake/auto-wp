import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeSiteConnection } from '../src/fakes/index.js';
import {
  ACTION_NAMES,
  AgentTransportConfigSchema,
  AppConfigSchema,
  actionSchemas,
  backupRunDir,
  canonicalString,
  DB_ARTIFACT,
  DEFAULT_BACKUP_EXCLUDES,
  DUMP_TERMINATOR_PREFIX,
  expandHome,
  FILES_ARTIFACT,
  ITEM_SNAPSHOT_DIR,
  ItemVulnAssessmentSchema,
  LONG_RUNNING_ACTIONS,
  MAINTENANCE_BYPASS_COOKIE,
  MANIFEST_FILE,
  MANIFEST_SIG_FILE,
  mergePolicy,
  PathJailError,
  PolicyOverrideSchema,
  PolicySchema,
  SiteConfigSchema,
  Slug,
  TOOL_NAMES,
  TOOL_VERSION,
  TransportConfigSchema,
  UpdateItemSchema,
  WpPluginInfoSchema,
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

  it('keeps app-level backupMaxAgeMinutes: 30 when site overrides only dbSnapshot', () => {
    const appPolicy = PolicySchema.parse({ backupMaxAgeMinutes: 30 });
    const site = SiteConfigSchema.parse({
      id: 'site-a',
      name: 'Site A',
      url: 'https://example.com',
      transport: {
        kind: 'ssh',
        host: 'example.com',
        username: 'cp',
        hostKeySha256: 'SHA256:abc=',
        wpRoot: '/home/cp/public_html',
      },
      policy: { dbSnapshot: 'always' },
    });
    const merged = mergePolicy(appPolicy, site.policy);
    expect(merged.dbSnapshot).toBe('always');
    expect(merged.backupMaxAgeMinutes).toBe(30);
  });

  it('deep merges policy thresholds and retention while replacing arrays', () => {
    const base = PolicySchema.parse({
      holds: ['plugin:old'],
      thresholds: { pixelDiffPct: 2, slowdownFactor: 1.5, slowdownMinMs: 300 },
      retention: { remote: 3, local: 14 },
    });
    const override = PolicyOverrideSchema.parse({
      holds: ['plugin:new'],
      thresholds: { pixelDiffPct: 5 },
      retention: { remote: 10 },
    });
    const merged = mergePolicy(base, override);
    expect(merged.holds).toEqual(['plugin:new']);
    expect(merged.thresholds).toEqual({ pixelDiffPct: 5, slowdownFactor: 1.5, slowdownMinMs: 300 });
    expect(merged.retention).toEqual({ remote: 10, local: 14 });

    const mergedEmpty = mergePolicy(base, undefined);
    expect(mergedEmpty).toEqual(base);
  });
});

describe('slug validation', () => {
  it('accepts valid slugs', () => {
    for (const s of ['akismet', 'woocommerce', 'my-plugin', 'theme_1', 'a', 'plugin.name']) {
      expect(Slug.safeParse(s).success).toBe(true);
    }
  });

  it('rejects invalid slugs: dots, empty string, leading dash/dot', () => {
    for (const s of ['.', '..', '', '-leading', '.leading', 'has space', 'a/b']) {
      expect(Slug.safeParse(s).success).toBe(false);
    }
  });
});

describe('WpPluginInfoSchema', () => {
  const validPlugin = {
    slug: 'akismet',
    file: 'akismet/akismet.php',
    name: 'Akismet',
    version: '5.0',
    active: true,
  };

  it('accepts updateUri as string, false, or undefined', () => {
    expect(
      WpPluginInfoSchema.safeParse({ ...validPlugin, updateUri: 'https://updates.example.com' }).success,
    ).toBe(true);
    expect(WpPluginInfoSchema.safeParse({ ...validPlugin, updateUri: false }).success).toBe(true);
    expect(WpPluginInfoSchema.safeParse(validPlugin).success).toBe(true);
    expect(WpPluginInfoSchema.safeParse({ ...validPlugin, updateUri: true }).success).toBe(false);
    expect(WpPluginInfoSchema.safeParse({ ...validPlugin, updateUri: 123 }).success).toBe(false);
  });
});

describe('domain schemas', () => {
  it('UpdateItemSchema accepts optional requiresPlugins', () => {
    const item = {
      type: 'plugin' as const,
      slug: 'my-addon',
      name: 'Addon',
      currentVersion: '1.0',
      newVersion: '1.1',
      active: true,
      source: 'wporg' as const,
      isMajor: false,
      requiresPlugins: ['woocommerce'],
    };
    expect(UpdateItemSchema.safeParse(item).success).toBe(true);
    expect(UpdateItemSchema.safeParse({ ...item, requiresPlugins: undefined }).success).toBe(true);
  });

  it('ItemVulnAssessmentSchema accepts optional lookupFailed', () => {
    const assessment = {
      item: {
        type: 'plugin' as const,
        slug: 'my-addon',
        name: 'Addon',
        currentVersion: '1.0',
        newVersion: '1.1',
        active: true,
        source: 'wporg' as const,
        isMajor: false,
      },
      affectingOld: [],
      stillAffectingNew: [],
      sources: ['wordfence'],
      errors: [],
      lookupFailed: { old: true, new: false },
    };
    expect(ItemVulnAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(ItemVulnAssessmentSchema.safeParse({ ...assessment, lookupFailed: undefined }).success).toBe(true);
  });
});

describe('actions catalogue', () => {
  it('includes wp.upgrade in LONG_RUNNING_ACTIONS', () => {
    expect(LONG_RUNNING_ACTIONS).toContain('wp.upgrade');
  });
});

describe('agent transport endpoint validation', () => {
  const baseAgent = {
    kind: 'agent' as const,
    keyId: 'key-1',
    signingKeyRef: 'secret:agent-key',
  };

  it('allows https endpoints regardless of host', () => {
    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'https://example.com/agent.php',
      }).success,
    ).toBe(true);
    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'https://localhost/agent.php',
      }).success,
    ).toBe(true);
  });

  it('requires https unless insecureHttpLoopback is true for loopback host', () => {
    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'http://localhost/agent.php',
        insecureHttpLoopback: false,
      }).success,
    ).toBe(false);

    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'http://localhost/agent.php',
        insecureHttpLoopback: true,
      }).success,
    ).toBe(true);

    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'http://127.0.0.1/agent.php',
        insecureHttpLoopback: true,
      }).success,
    ).toBe(true);

    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'http://127.255.0.1/agent.php',
        insecureHttpLoopback: true,
      }).success,
    ).toBe(true);

    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'http://[::1]/agent.php',
        insecureHttpLoopback: true,
      }).success,
    ).toBe(true);

    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'http://example.com/agent.php',
        insecureHttpLoopback: true,
      }).success,
    ).toBe(false);

    expect(
      AgentTransportConfigSchema.safeParse({
        ...baseAgent,
        endpoint: 'http://192.168.1.1/agent.php',
        insecureHttpLoopback: true,
      }).success,
    ).toBe(false);
  });

  it('validates endpoint in SftpAgentTransportConfigSchema and TransportConfigSchema', () => {
    const valid = {
      kind: 'sftp+agent' as const,
      sftp: {
        host: 'example.com',
        username: 'cp',
        hostKeySha256: 'SHA256:abc=',
        wpRoot: '/var/www',
      },
      agent: {
        endpoint: 'https://example.com/agent.php',
        keyId: 'k',
        signingKeyRef: 'secret:k',
      },
    };
    expect(TransportConfigSchema.safeParse(valid).success).toBe(true);

    const invalid = {
      ...valid,
      agent: {
        ...valid.agent,
        endpoint: 'http://example.com/agent.php',
        insecureHttpLoopback: true,
      },
    };
    expect(TransportConfigSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('expandHome', () => {
  it('expands leading ~ and ~/', () => {
    const fakeHome = '/home/testuser';
    expect(expandHome('~', fakeHome)).toBe('/home/testuser');
    expect(expandHome('~/public_html', fakeHome)).toBe('/home/testuser/public_html');
    expect(expandHome('~/a/b/c', fakeHome)).toBe('/home/testuser/a/b/c');
  });

  it('leaves other paths untouched', () => {
    const fakeHome = '/home/testuser';
    expect(expandHome('/var/www', fakeHome)).toBe('/var/www');
    expect(expandHome('relative/path', fakeHome)).toBe('relative/path');
    expect(expandHome('~otheruser/dir', fakeHome)).toBe('~otheruser/dir');
  });
});

describe('backup-layout', () => {
  it('exports expected constants and layout helpers', () => {
    expect(MANIFEST_FILE).toBe('manifest.json');
    expect(MANIFEST_SIG_FILE).toBe('manifest.json.sig');
    expect(DB_ARTIFACT).toBe('db.sql.gz');
    expect(FILES_ARTIFACT).toBe('files.tar.gz');
    expect(ITEM_SNAPSHOT_DIR).toBe('items');
    expect(DUMP_TERMINATOR_PREFIX).toBe('-- Dump completed');
    expect(DEFAULT_BACKUP_EXCLUDES).toEqual([
      'auto-wp-backup',
      'auto-wp-agent/.data',
      'wp-content/cache',
      'wp-content/updraft',
      'wp-content/ai1wm-backups',
      'wp-content/backups-dup-lite',
      'wp-content/uploads/backup*',
      '*.log',
    ]);
    expect(backupRunDir('/var/www/html', 'backup-123')).toBe('/var/www/html/auto-wp-backup/backup-123');
    expect(backupRunDir('/var/www/html/', 'backup-123')).toBe('/var/www/html/auto-wp-backup/backup-123');
  });
});

describe('protocol and version constants', () => {
  it('exports MAINTENANCE_BYPASS_COOKIE and updated TOOL_VERSION', () => {
    expect(MAINTENANCE_BYPASS_COOKIE).toBe('autowp_bypass');
    expect(TOOL_VERSION).toBe('0.2.0');
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

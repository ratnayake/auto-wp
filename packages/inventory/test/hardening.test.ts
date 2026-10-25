import { itemKey, PolicySchema } from '@auto-wp/contracts';
import { DEFAULT_FAKE_CAPS, MemoryLogger } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DefaultInventoryService } from '../src/index.js';
import { extractJson, extractVersion } from '../src/wp-output.js';
import checkUpdate from './fixtures/wp-core-check-update.json' with { type: 'json' };
import inventory from './fixtures/wp-inventory.json' with { type: 'json' };
import pluginList from './fixtures/wp-plugin-list.json' with { type: 'json' };
import themeList from './fixtures/wp-theme-list.json' with { type: 'json' };
import transientCore from './fixtures/wp-transient-core.json' with { type: 'json' };
import transientPlugins from './fixtures/wp-transient-plugins.json' with { type: 'json' };
import transientThemes from './fixtures/wp-transient-themes.json' with { type: 'json' };
import { subcommand, WP_BIN, wpCliSite } from './helpers.js';

const logger = new MemoryLogger();
const service = new DefaultInventoryService(logger);
const caps = { ...DEFAULT_FAKE_CAPS, phpVersion: '8.2.0' };
const policy = PolicySchema.parse({});
const json = (v: unknown) => JSON.stringify(v);

const cleanReplies: Record<string, { stdout: string; exitCode?: number }> = {
  'core version': { stdout: '6.6.2\n' },
  'core check-update': { stdout: json(checkUpdate) },
  'option get _site_transient_update_core': { stdout: json(transientCore) },
  'plugin list': { stdout: json(pluginList) },
  'option get _site_transient_update_plugins': { stdout: json(transientPlugins) },
  'theme list': { stdout: json(themeList) },
  'option get _site_transient_update_themes': { stdout: json(transientThemes) },
  'theme get twentytwentyfour': { stdout: 'twentytwentyfour\n' },
  'theme get hello-elementor': { stdout: 'hello-elementor\n' },
  'theme get hello-elementor-child': { stdout: 'hello-elementor\n' },
};

/** Wraps every reply with PHP notices, as a noisy plugin on a shared host would print them. */
const noisy = (replies: typeof cleanReplies) =>
  Object.fromEntries(
    Object.entries(replies).map(([k, r]) => [
      k,
      {
        ...r,
        stdout: `PHP Deprecated:  Old function in /var/www/html/wp-content/plugins/x.php on line 3\n${r.stdout}\nWarning: [ignored] done\n`,
      },
    ]),
  );

const anyJson = z.unknown();

describe('extractJson', () => {
  it('ignores PHP messages printed before and after the payload', () => {
    const out = 'PHP Deprecated: foo [bar] in x.php\n[{"a":1}]\nNotice: done [x]\n';
    expect(extractJson(out, anyJson)).toEqual([{ a: 1 }]);
  });

  it('skips error_log lines that start with a bracket', () => {
    const out = '[28-Oct-2026 10:00:00] PHP Warning: x\n{"ok":true}\n';
    expect(extractJson(out, anyJson)).toEqual({ ok: true });
  });

  it('returns undefined when no payload is present', () => {
    expect(extractJson('Fatal error: boom\n', anyJson)).toBeUndefined();
  });

  it('takes the last version line as the installed core', () => {
    expect(extractVersion('Deprecated: old thing\n6.4.3\n')).toBe('6.4.3');
    expect(extractVersion('Fatal error\n')).toBeUndefined();
  });
});

describe('noisy WP-CLI output', () => {
  it('detects the same items as clean output', async () => {
    const clean = await service.detect(wpCliSite(cleanReplies));
    const dirty = await service.detect(wpCliSite(noisy(cleanReplies)));
    expect(dirty).toEqual(clean);
    expect(dirty.length).toBeGreaterThan(0);
  });

  it('falls back to the agent when the core version cannot be read', async () => {
    const c = wpCliSite({ ...cleanReplies, 'core version': { stdout: 'Fatal error: boom\n' } });
    c.onCall('wp.inventory', () => inventory);
    const detection = await service.inspect(c);
    expect(detection.installedCore).toBe('6.6.2');
    expect(c.ops.map((o) => o.op)).toContain('call:wp.inventory');
  });
});

describe('installed core', () => {
  const noCoreUpdate = { ...cleanReplies, 'core check-update': { stdout: '[]' } };

  it('is reported even when no core update is pending', async () => {
    const detection = await service.inspect(wpCliSite(noCoreUpdate));
    expect(detection.installedCore).toBe('6.6.2');
    expect(detection.items.some((i) => i.type === 'core')).toBe(false);
  });

  it('holds plugins needing a newer core than the installed one when no core update is planned', async () => {
    const c = wpCliSite({
      ...noCoreUpdate,
      'option get _site_transient_update_plugins': {
        stdout: json({ response: { 'woocommerce/woocommerce.php': { requires: '6.8' } } }),
      },
    });
    const { items, installedCore } = await service.inspect(c);
    const out = service.plan(items, caps, policy, installedCore);
    const woo = out.find((i) => i.slug === 'woocommerce');
    expect(woo?.heldReason).toContain('6.8');
    const firstHeld = out.findIndex((i) => i.heldReason !== undefined);
    expect(out.slice(firstHeld).every((i) => i.heldReason !== undefined)).toBe(true);
  });

  it('is needed for requiresWp checks when there is no core item', () => {
    const items = [
      {
        type: 'plugin' as const,
        slug: 'p',
        name: 'p',
        currentVersion: '1.0.0',
        newVersion: '1.0.1',
        active: true,
        source: 'unknown' as const,
        isMajor: false,
        requiresWp: '6.8',
      },
    ];
    expect(service.plan(items, caps, policy)[0]?.heldReason).toBeUndefined();
    expect(service.plan(items, caps, policy, '6.6.2')[0]?.heldReason).toContain('6.8');
  });
});

describe('requirement headers from update transients', () => {
  it('sets requiresWp and requiresPhp on WP-CLI items and orders the dependent after core major', async () => {
    const { items, installedCore } = await service.inspect(wpCliSite(cleanReplies));
    const out = service.plan(items, caps, policy, installedCore);
    const keys = out.map(itemKey);
    expect(keys.indexOf('core:wordpress')).toBeLessThan(keys.indexOf('plugin:woocommerce'));
    expect(out.find((i) => i.slug === 'woocommerce')).toMatchObject({
      requiresWp: '6.7',
      requiresPhp: '7.4',
    });
    expect(out.find((i) => i.slug === 'woocommerce')?.heldReason).toBeUndefined();
  });

  it('leaves requirements unset when the transient is missing', async () => {
    const replies = { ...cleanReplies, 'option get _site_transient_update_plugins': { exitCode: 1 } };
    const items = (await service.inspect(wpCliSite(replies))).items;
    expect(items.find((i) => i.slug === 'woocommerce')).not.toHaveProperty('requiresWp');
  });

  it('reads the transient without loading plugins or themes', async () => {
    const c = wpCliSite(cleanReplies);
    await service.inspect(c);
    const argvs = c.ops.filter((o) => o.op === 'exec').map((o) => (o.args as { argv: string[] }).argv);
    for (const argv of argvs) expect(argv[0]).toBe(WP_BIN);
    expect(argvs.map(subcommand)).toContain('option get _site_transient_update_plugins');
  });
});

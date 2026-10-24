import { FakeSiteConnection, MemoryLogger } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { DefaultInventoryService } from '../src/index.js';
import checkUpdate from './fixtures/wp-core-check-update.json' with { type: 'json' };
import inventory from './fixtures/wp-inventory.json' with { type: 'json' };
import pluginList from './fixtures/wp-plugin-list.json' with { type: 'json' };
import themeList from './fixtures/wp-theme-list.json' with { type: 'json' };
import { subcommand, WP_BIN, wpCliSite } from './helpers.js';

const service = () => new DefaultInventoryService(new MemoryLogger());
const json = (v: unknown) => JSON.stringify(v);

const cliReplies = {
  'core version': { stdout: '6.6.2\n' },
  'core check-update': { stdout: json(checkUpdate) },
  'plugin list': { stdout: json(pluginList) },
  'theme list': { stdout: json(themeList) },
  'theme get hello-elementor-child': { stdout: 'hello-elementor\n' },
  'theme get hello-elementor': { stdout: 'hello-elementor\n' },
  'theme get twentytwentyfour': { exitCode: 1 },
};

describe('DefaultInventoryService.detect via WP-CLI', () => {
  it('returns only items with an update, normalised', async () => {
    const c = wpCliSite(cliReplies);
    const items = await service().detect(c);

    expect(items.map((i) => `${i.type}:${i.slug}`)).toEqual([
      'core:wordpress',
      'plugin:akismet',
      'plugin:hello',
      'plugin:woocommerce',
      'theme:twentytwentyfour',
      'theme:hello-elementor',
      'theme:hello-elementor-child',
    ]);
    expect(items[0]).toMatchObject({
      currentVersion: '6.6.2',
      newVersion: '6.7',
      isMajor: true,
      source: 'wporg',
      active: true,
    });
    expect(items.find((i) => i.slug === 'akismet')).toMatchObject({ isMajor: false, active: true });
    expect(items.find((i) => i.slug === 'woocommerce')).toMatchObject({
      newVersion: '10.0.0',
      isMajor: true,
      active: true,
      source: 'unknown',
    });
    expect(items.find((i) => i.slug === 'hello')).toMatchObject({ active: false, newVersion: '1.8' });
    expect(items.find((i) => i.slug === 'hello-elementor-child')).toMatchObject({
      parentTheme: 'hello-elementor',
      active: true,
    });
    expect(items.find((i) => i.slug === 'hello-elementor')).toMatchObject({ active: true });
    expect(items.find((i) => i.slug === 'hello-elementor')).not.toHaveProperty('parentTheme');
  });

  it('never reports must-use plugins or items without an update', async () => {
    const items = await service().detect(wpCliSite(cliReplies));
    const slugs = items.map((i) => i.slug);
    expect(slugs).not.toContain('site-helper');
    expect(slugs).not.toContain('contact-form-7');
    expect(slugs).not.toContain('storefront');
  });

  it('runs argv only with --path and --no-color', async () => {
    const c = wpCliSite(cliReplies);
    await service().detect(c);
    const execs = c.ops.filter((o) => o.op === 'exec').map((o) => (o.args as { argv: string[] }).argv);
    expect(execs.length).toBeGreaterThan(0);
    for (const argv of execs) {
      expect(argv[0]).toBe(WP_BIN);
      expect(argv).toContain('--path=/var/www/html');
      expect(argv).toContain('--no-color');
    }
    expect(execs.map(subcommand)).toEqual([
      'core version',
      'core check-update',
      'plugin list',
      'theme list',
      'theme get twentytwentyfour',
      'theme get hello-elementor',
      'theme get hello-elementor-child',
    ]);
  });

  it('leaves the parent unset when the lookup fails', async () => {
    const items = await service().detect(wpCliSite(cliReplies));
    expect(items.find((i) => i.slug === 'twentytwentyfour')).not.toHaveProperty('parentTheme');
  });

  it('treats empty check-update output as no core update', async () => {
    const items = await service().detect(wpCliSite({ ...cliReplies, 'core check-update': { stdout: '' } }));
    expect(items.some((i) => i.type === 'core')).toBe(false);
  });

  it('fails when core check-update exits non-zero', async () => {
    const replies = { ...cliReplies, 'core check-update': { exitCode: 1 } };
    await expect(service().detect(wpCliSite(replies))).rejects.toThrow(/core check-update failed/);
  });

  it.each(['--ssh-option', '.', '..', 'a/b'])('rejects unsafe slug %s', async (name) => {
    const hostile = [{ ...pluginList[0], name }];
    const replies = { ...cliReplies, 'plugin list': { stdout: json(hostile) } };
    const items = await service().detect(wpCliSite(replies));
    expect(items.find((i) => i.type === 'plugin')).toBeUndefined();
  });
});

describe('DefaultInventoryService.detect via wp.inventory', () => {
  const agentSite = () => {
    const c = new FakeSiteConnection('site-b', 'agent', { shell: false });
    c.onCall('wp.inventory', () => inventory);
    return c;
  };

  it('is used when shell access is unavailable', async () => {
    const c = agentSite();
    await service().detect(c);
    expect(c.ops.map((o) => o.op)).toContain('call:wp.inventory');
    expect(c.ops.some((o) => o.op === 'exec')).toBe(false);
  });

  it('is used when WP-CLI is unavailable even with shell access', async () => {
    const c = new FakeSiteConnection('site-c', 'ssh', { wpCli: { available: false } });
    c.onCall('wp.inventory', () => inventory);
    await service().detect(c);
    expect(c.ops.some((o) => o.op === 'exec')).toBe(false);
  });

  it('skips updateUri=false, must-use and no-update entries, and maps requirements', async () => {
    const items = await service().detect(agentSite());
    expect(items.map((i) => `${i.type}:${i.slug}`)).toEqual([
      'core:wordpress',
      'plugin:akismet',
      'plugin:gravityforms-addon',
      'plugin:woocommerce',
      'theme:hello-elementor',
      'theme:hello-elementor-child',
    ]);
    expect(items[0]).toMatchObject({ requiresPhp: '7.4', source: 'wporg', isMajor: true });
    expect(items.find((i) => i.slug === 'gravityforms-addon')).toMatchObject({
      source: 'premium',
      requiresWp: '6.5',
      requiresPlugins: ['gravityforms'],
    });
    expect(items.find((i) => i.slug === 'woocommerce')).toMatchObject({
      requiresWp: '6.7',
      requiresPhp: '7.4',
    });
    expect(items.find((i) => i.slug === 'hello-elementor-child')).toMatchObject({
      parentTheme: 'hello-elementor',
      source: 'unknown',
    });
  });
});

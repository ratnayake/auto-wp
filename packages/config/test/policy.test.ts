import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addSite,
  ConfigError,
  loadConfig,
  parseAppConfigText,
  removeSite,
  resolveSitePolicy,
  saveConfig,
} from '../src/index.js';
import { SITE_YAML, tempDir } from './helpers.js';

/** A site as YAML. `extra` holds top-level site keys (e.g. `policy:`), at column 0. */
const siteBlock = (id: string, extra = '') =>
  `${SITE_YAML.trim().replace('id: blog', `id: ${id}`).replace('wpRoot: /home/deploy/public_html', `wpRoot: /w/${id}`)}\n${extra}`;

const sitesYaml = (...blocks: string[]) =>
  `sites:\n${blocks.map((b) => `  - ${b.trim().split('\n').join('\n    ')}`).join('\n')}\n`;

describe('resolveSitePolicy', () => {
  it('uses the app policy when the site sets nothing', () => {
    const app = parseAppConfigText(`policy:\n  dbSnapshot: never\n${sitesYaml(siteBlock('a'))}`, 'x');
    expect(resolveSitePolicy(app, app.sites[0]!).dbSnapshot).toBe('never');
  });

  it('lets a site override a field, including one set to the schema default', () => {
    const yaml = `policy:\n  dbSnapshot: never\n  backupMaxAgeMinutes: 10\n${sitesYaml(
      siteBlock('a', 'policy:\n  dbSnapshot: auto'),
    )}`;
    const app = parseAppConfigText(yaml, 'x');
    const policy = resolveSitePolicy(app, app.sites[0]!);
    expect(policy.dbSnapshot).toBe('auto');
    expect(policy.backupMaxAgeMinutes).toBe(10);
  });

  it('merges nested thresholds field by field and replaces arrays', () => {
    const yaml = `policy:\n  thresholds: { pixelDiffPct: 5, slowdownFactor: 2, slowdownMinMs: 500 }\n  holds: [plugin:a]\n${sitesYaml(
      siteBlock('a', 'policy:\n  thresholds:\n    pixelDiffPct: 1\n  holds: [theme:b]'),
    )}`;
    const app = parseAppConfigText(yaml, 'x');
    const policy = resolveSitePolicy(app, app.sites[0]!);
    expect(policy.thresholds).toEqual({ pixelDiffPct: 1, slowdownFactor: 2, slowdownMinMs: 500 });
    expect(policy.holds).toEqual(['theme:b']);
  });

  it('rejects an invalid override value at load time, naming the field', () => {
    expect(() =>
      parseAppConfigText(sitesYaml(siteBlock('a', 'policy:\n  dbSnapshot: sometimes')), 'x'),
    ).toThrow(/sites\[0\]\.policy\.dbSnapshot/);
  });

  it('keeps overrides on copies, and reads them live from site.policy', () => {
    const app = parseAppConfigText('sites: []\npolicy:\n  dbSnapshot: never\n', 'x');
    const parsed = parseAppConfigText(sitesYaml(siteBlock('a', 'policy:\n  dbSnapshot: auto')), 'y')
      .sites[0]!;
    const copy = { ...parsed, name: 'renamed' };
    expect(resolveSitePolicy(app, copy).dbSnapshot).toBe('auto');

    // site.policy holds only explicit overrides, so no default-valued field is mistaken for one.
    expect(parsed.policy).toEqual({ dbSnapshot: 'auto' });
    const mutated = { ...parsed, policy: { backupMaxAgeMinutes: 7 } } as typeof parsed;
    expect(resolveSitePolicy(app, mutated)).toMatchObject({ dbSnapshot: 'never', backupMaxAgeMinutes: 7 });
  });
});

describe('saveConfig', () => {
  it('writes only explicit site overrides, so later app-level changes still apply', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.yaml');
    const app0 = parseAppConfigText('sites: []\npolicy:\n  dbSnapshot: never\n', 'x');
    const app = addSite(app0, {
      id: 'blog',
      name: 'Blog',
      url: 'https://blog.example.com',
      transport: {
        kind: 'agent',
        endpoint: 'https://blog.example.com/auto-wp-agent/agent.php',
        keyId: 'k1',
        signingKeyRef: 'secret:blog-key',
      },
    });
    await saveConfig(app, file);
    expect(await readFile(file, 'utf8')).toMatch(/policy: \{\}/);

    const reloaded = await loadConfig(file);
    expect(resolveSitePolicy(reloaded, reloaded.sites[0]!).dbSnapshot).toBe('never');
  });

  it('keeps an explicit override that equals the default', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.yaml');
    await writeFile(
      file,
      `policy:\n  dbSnapshot: never\n${sitesYaml(siteBlock('a', 'policy:\n  dbSnapshot: auto'))}`,
    );
    const app = await loadConfig(file);
    await saveConfig(app, file);
    const reloaded = await loadConfig(file);
    expect(resolveSitePolicy(reloaded, reloaded.sites[0]!).dbSnapshot).toBe('auto');
  });

  it('refuses to write an invalid config and leaves the existing file untouched', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.yaml');
    const app = parseAppConfigText('sites: []', 'x');
    await saveConfig(app, file);
    const before = await readFile(file, 'utf8');
    await expect(saveConfig({ ...app, stateDir: 42 } as never, file)).rejects.toThrow(
      /refusing to save invalid config/,
    );
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

describe('addSite / removeSite', () => {
  it('adds a validated site and rejects duplicates and bad input', () => {
    const app = parseAppConfigText(sitesYaml(siteBlock('a')), 'x');
    const next = addSite(app, { ...app.sites[0], id: 'b' });
    expect(next.sites.map((s) => s.id)).toEqual(['a', 'b']);
    expect(app.sites).toHaveLength(1);
    expect(() => addSite(app, { ...app.sites[0] })).toThrow(/already registered: a/);
    expect(() => addSite(app, { id: 'Bad Id' })).toThrow(ConfigError);
  });

  it('removes a site and rejects unknown ids', () => {
    const app = parseAppConfigText(sitesYaml(siteBlock('a')), 'x');
    expect(removeSite(app, 'a').sites).toEqual([]);
    expect(() => removeSite(app, 'zzz')).toThrow(/no site with id: zzz/);
  });
});

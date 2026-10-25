import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseAppConfigText, resolveConfigPath } from '../src/index.js';
import { SITE_YAML, tempDir } from './helpers.js';

describe('config schema', () => {
  it('applies defaults for an empty document and for minimal sites', () => {
    const app = parseAppConfigText('', 'empty.yaml');
    expect(app.sites).toEqual([]);
    expect(app.policy.dbSnapshot).toBe('auto');
    expect(app.policy.retention).toEqual({ remote: 3, local: 14 });

    const withSite = parseAppConfigText(`sites:\n  - ${SITE_YAML.trim().split('\n').join('\n    ')}\n`, 'x');
    const site = withSite.sites[0];
    expect(site?.healthUrls).toEqual(['/', '/wp-login.php', '/wp-json/']);
    expect(site?.backupLocation).toBe('docroot');
    expect(site?.logFiles).toEqual(['wp-content/debug.log', 'error_log']);
    expect(site?.transport.kind).toBe('ssh');
    if (site?.transport.kind === 'ssh') {
      expect(site.transport.port).toBe(22);
      expect(site.transport.phpBinary).toBe('php');
    }
  });

  it('expands ~ in stateDir and dataDir', () => {
    const app = parseAppConfigText('sites: []\nstateDir: ~/state\ndataDir: "~"\n', 'x');
    expect(app.stateDir).toBe(join(homedir(), 'state'));
    expect(app.dataDir).toBe(homedir());
  });

  it('reports the failing field path', () => {
    const yaml = `sites:
  - id: Bad_ID
    name: Blog
    url: not-a-url
    transport:
      kind: ssh
      host: h
      username: u
      hostKeySha256: nope
      wpRoot: /w
`;
    let message = '';
    try {
      parseAppConfigText(yaml, 'bad.yaml');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^invalid config bad\.yaml:/);
    expect(message).toMatch(/sites\[0\]\.id/);
    expect(message).toMatch(/sites\[0\]\.url/);
    expect(message).toMatch(/sites\[0\]\.transport\.hostKeySha256/);
  });

  it('rejects a non-secret ref in vulndb', () => {
    expect(() => parseAppConfigText('vulndb:\n  wpscanTokenRef: plaintext-token\n', 'x')).toThrow(
      /vulndb\.wpscanTokenRef/,
    );
  });

  it('rejects a site without sites list at top level', () => {
    expect(() => parseAppConfigText('stateDir: /x\n', 'x')).toThrow(/sites/);
  });

  it('reports YAML syntax errors with a location and no file content', () => {
    try {
      parseAppConfigText('sites: [\n  password: hunter2\n', 'y.yaml');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/^y\.yaml:\d+:\d+: invalid YAML/);
    }
  });

  it('resolves the config path from the argument, then AUTOWP_CONFIG, then the default', () => {
    expect(resolveConfigPath('~/a.yaml', {})).toBe(join(homedir(), 'a.yaml'));
    expect(resolveConfigPath(undefined, { AUTOWP_CONFIG: '/etc/autowp.yaml' })).toBe('/etc/autowp.yaml');
    expect(resolveConfigPath(undefined, {})).toBe(join(homedir(), '.config/auto-wp/config.yaml'));
  });

  it('loads from disk and reports a missing file clearly', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.yaml');
    await writeFile(file, `sites:\n  - ${SITE_YAML.trim().split('\n').join('\n    ')}\n`);
    const app = await loadConfig(file);
    expect(app.sites.map((s) => s.id)).toEqual(['blog']);

    await expect(loadConfig(join(dir, 'missing.yaml'))).rejects.toThrow(/config file not found/);
    const empty = await loadConfig(join(dir, 'missing.yaml'), { allowMissing: true });
    expect(empty.sites).toEqual([]);
  });
});

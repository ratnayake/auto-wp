import { readFile } from 'node:fs/promises';
import { type AppConfig, AppConfigSchema, type SiteConfig } from '@auto-wp/contracts';
import YAML, { YAMLParseError } from 'yaml';
import { atomicWriteFile } from './atomic-file.js';
import { ConfigError, errorCode, firstLine, formatIssues } from './errors.js';
import { expandHome, resolveConfigPath } from './paths.js';
import { parseSiteConfig, withExplicitPolicy } from './site-policy.js';

export interface LoadConfigOptions {
  /** Return an empty config instead of failing when the file does not exist yet. */
  allowMissing?: boolean;
}

/**
 * Reads and validates the config. Path: argument, else `$AUTOWP_CONFIG`, else `~/.config/auto-wp/config.yaml`.
 */
export async function loadConfig(path?: string, opts: LoadConfigOptions = {}): Promise<AppConfig> {
  const file = resolveConfigPath(path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') {
      if (opts.allowMissing) return parseAppConfig(undefined, file);
      throw new ConfigError(`config file not found: ${file} (create it or set AUTOWP_CONFIG)`);
    }
    throw new ConfigError(`cannot read config file ${file}: ${code ?? firstLine(err)}`);
  }
  return parseAppConfigText(text, file);
}

export function parseAppConfigText(text: string, source: string): AppConfig {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    const pos = err instanceof YAMLParseError ? err.linePos?.[0] : undefined;
    const where = pos ? `:${pos.line}:${pos.col}` : '';
    throw new ConfigError(`${source}${where}: invalid YAML: ${firstLine(err)}`);
  }
  return parseAppConfig(doc, source);
}

/** Validates a parsed document. An empty document is an empty config (no sites). */
export function parseAppConfig(doc: unknown, source: string): AppConfig {
  const input = doc ?? { sites: [] };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError(`${source}: the top level must be a mapping with a 'sites' list`);
  }
  const parsed = AppConfigSchema.safeParse(input);
  if (!parsed.success)
    throw new ConfigError(`invalid config ${source}:\n${formatIssues(parsed.error.issues)}`);

  const rawSites: unknown[] = Array.isArray((input as { sites?: unknown }).sites)
    ? (input as { sites: unknown[] }).sites
    : [];
  return {
    ...parsed.data,
    sites: parsed.data.sites.map((site, i) => withExplicitPolicy(site, rawSites[i])),
    stateDir: expandHome(parsed.data.stateDir),
    dataDir: expandHome(parsed.data.dataDir),
  };
}

/** Writes the config atomically with mode 0600. Refuses to write a config that would not validate. */
export async function saveConfig(app: AppConfig, path?: string): Promise<void> {
  const file = resolveConfigPath(path);
  const check = AppConfigSchema.safeParse(app);
  if (!check.success) {
    throw new ConfigError(`refusing to save invalid config:\n${formatIssues(check.error.issues)}`);
  }
  // Sites hold only their explicit policy overrides, so app-level changes still apply to them.
  await atomicWriteFile(file, YAML.stringify(app), 0o600);
}

/** Returns a new config with the site appended. The id must be unused. */
export function addSite(app: AppConfig, input: unknown): AppConfig {
  const site: SiteConfig = parseSiteConfig(input);
  if (app.sites.some((s) => s.id === site.id))
    throw new ConfigError(`site id already registered: ${site.id}`);
  return { ...app, sites: [...app.sites, site] };
}

/** Returns a new config without the site with this id. */
export function removeSite(app: AppConfig, id: string): AppConfig {
  if (!app.sites.some((s) => s.id === id)) throw new ConfigError(`no site with id: ${id}`);
  return { ...app, sites: app.sites.filter((s) => s.id !== id) };
}

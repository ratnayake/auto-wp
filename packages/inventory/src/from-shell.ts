import type { Capabilities, SiteConnection } from '@auto-wp/contracts';
import { z } from 'zod';
import { buildItem, type InventoryItem, isNewer, sourceOf } from './item.js';
import { extractJson, extractSlug, extractVersion, SLUG_PATTERN, VERSION_PATTERN } from './wp-output.js';

export interface ShellDetection {
  /** Installed WordPress core version. Known even when no core update is pending. */
  installedCore: string;
  items: InventoryItem[];
}

export interface ShellLog {
  warn(msg: string): void;
}

/** Read-only WP-CLI calls skip plugin and theme loading so a broken plugin cannot break detection. */
const READ_ONLY_FLAGS = ['--skip-plugins', '--skip-themes'] as const;

const WpCliCoreUpdate = z.array(
  z.object({ version: z.string(), update_type: z.string().optional(), package_url: z.string().optional() }),
);
const WpCliPlugin = z.object({
  name: z.string(),
  title: z.string().optional(),
  status: z.string(),
  version: z.string(),
  update: z.string(),
  update_version: z.string().nullish(),
  file: z.string().optional(),
});
const WpCliTheme = z.object({
  name: z.string(),
  title: z.string().optional(),
  status: z.string(),
  version: z.string(),
  update: z.string(),
  update_version: z.string().nullish(),
});

/** Statuses WP-CLI reports for loaders that are never update items. */
const NEVER_UPDATED = new Set(['must-use', 'dropin']);

/** Requirement headers WordPress stored with an update offer. Missing or malformed fields are left empty. */
interface UpdateHint {
  requires?: string;
  requires_php?: string;
  requires_plugins: string[];
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

function hintFor(entries: Record<string, unknown>, key: string): UpdateHint | undefined {
  const entry = entries[key];
  if (entry === null || typeof entry !== 'object') return undefined;
  const o = asRecord(entry);
  const plugins = Array.isArray(o.requires_plugins) ? o.requires_plugins : [];
  return {
    ...(nonEmptyString(o.requires) ? { requires: nonEmptyString(o.requires) } : {}),
    ...(nonEmptyString(o.requires_php) ? { requires_php: nonEmptyString(o.requires_php) } : {}),
    requires_plugins: plugins.filter((s): s is string => typeof s === 'string' && SLUG_PATTERN.test(s)),
  };
}

function parseList<T>(stdout: string, schema: z.ZodType<T[]>, what: string): T[] {
  if (stdout.trim() === '') return [];
  const parsed = extractJson(stdout, schema);
  if (parsed === undefined) throw new Error(`unexpected ${what} output`);
  return parsed;
}

/**
 * Detects updates via WP-CLI argv calls and reads `requires` headers from the update transients WordPress
 * stores (`_site_transient_update_*`). Those transients are as fresh as the last update check; when a
 * transient is missing the requirement stays unknown and its hold rule cannot fire.
 */
export async function detectFromShell(
  c: SiteConnection,
  caps: Capabilities,
  log: ShellLog,
): Promise<ShellDetection> {
  const bin = caps.wpCli.path ?? 'wp';
  const run = async (args: readonly string[]): Promise<string> => {
    const r = await c.exec([bin, `--path=${caps.wpRoot}`, '--no-color', ...READ_ONLY_FLAGS, ...args]);
    if (r.exitCode !== 0) throw new Error(`wp ${args.slice(0, 2).join(' ')} failed (exit ${r.exitCode})`);
    return r.stdout;
  };
  const transient = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return asRecord(extractJson(await run(['option', 'get', name, '--format=json']), z.unknown()));
    } catch {
      log.warn(`update transient ${name} unavailable`);
      return {};
    }
  };

  const installedCore = extractVersion(await run(['core', 'version']));
  if (!installedCore) throw new Error('could not determine WordPress core version');

  const items: InventoryItem[] = [];

  const coreUpdates = parseList(
    await run(['core', 'check-update', '--format=json']),
    WpCliCoreUpdate,
    'core check-update',
  ).filter((u) => VERSION_PATTERN.test(u.version));
  const coreTransient = await transient('_site_transient_update_core');
  let best: (typeof coreUpdates)[number] | undefined;
  for (const u of coreUpdates) {
    if (isNewer(u.version, installedCore) && (!best || isNewer(u.version, best.version))) best = u;
  }
  if (best) {
    const offer = Array.isArray(coreTransient.updates)
      ? coreTransient.updates
          .map(asRecord)
          .find((o) => o.response === 'upgrade' && o.version === best?.version)
      : undefined;
    const requiresPhp = typeof offer?.php_version === 'string' ? offer.php_version : undefined;
    items.push(
      buildItem({
        type: 'core',
        slug: 'wordpress',
        name: 'WordPress',
        currentVersion: installedCore,
        newVersion: best.version,
        active: true,
        source: sourceOf(best.package_url),
        ...(requiresPhp ? { requiresPhp } : {}),
      }),
    );
  }

  const plugins = parseList(
    await run([
      'plugin',
      'list',
      '--fields=name,title,status,version,update_version,update,file',
      '--format=json',
    ]),
    z.array(WpCliPlugin),
    'plugin list',
  );
  const pluginHints = asRecord((await transient('_site_transient_update_plugins')).response);
  for (const p of plugins) {
    if (NEVER_UPDATED.has(p.status) || p.file?.startsWith('mu-plugins/')) continue;
    if (p.update !== 'available' || !p.update_version || !isNewer(p.update_version, p.version)) continue;
    if (!SLUG_PATTERN.test(p.name)) {
      log.warn('skipping plugin with unexpected slug');
      continue;
    }
    const hint = p.file ? hintFor(pluginHints, p.file) : undefined;
    items.push(
      buildItem({
        type: 'plugin',
        slug: p.name,
        name: p.title ?? p.name,
        currentVersion: p.version,
        newVersion: p.update_version,
        active: p.status === 'active' || p.status === 'active-network',
        source: 'unknown',
        requiresPlugins: hint?.requires_plugins ?? [],
        ...(hint?.requires ? { requiresWp: hint.requires } : {}),
        ...(hint?.requires_php ? { requiresPhp: hint.requires_php } : {}),
      }),
    );
  }

  const themes = parseList(
    await run(['theme', 'list', '--fields=name,title,status,version,update_version,update', '--format=json']),
    z.array(WpCliTheme),
    'theme list',
  );
  const themeHints = asRecord((await transient('_site_transient_update_themes')).response);
  for (const t of themes) {
    if (t.update !== 'available' || !t.update_version || !isNewer(t.update_version, t.version)) continue;
    if (!SLUG_PATTERN.test(t.name)) {
      log.warn('skipping theme with unexpected slug');
      continue;
    }
    const hint = hintFor(themeHints, t.name);
    const parentTheme = await parentOfTheme(c, bin, caps.wpRoot, t.name);
    items.push(
      buildItem({
        type: 'theme',
        slug: t.name,
        name: t.title ?? t.name,
        currentVersion: t.version,
        newVersion: t.update_version,
        active: t.status === 'active' || t.status === 'parent',
        source: 'unknown',
        ...(parentTheme ? { parentTheme } : {}),
        ...(hint?.requires ? { requiresWp: hint.requires } : {}),
        ...(hint?.requires_php ? { requiresPhp: hint.requires_php } : {}),
      }),
    );
  }

  return { installedCore, items };
}

/** Parent slug for a child theme. Undefined when the theme is its own template or the lookup fails. */
async function parentOfTheme(
  c: SiteConnection,
  bin: string,
  wpRoot: string,
  slug: string,
): Promise<string | undefined> {
  const r = await c.exec([
    bin,
    `--path=${wpRoot}`,
    '--no-color',
    ...READ_ONLY_FLAGS,
    'theme',
    'get',
    slug,
    '--field=template',
  ]);
  if (r.exitCode !== 0) return undefined;
  const template = extractSlug(r.stdout);
  return template && template !== slug && SLUG_PATTERN.test(template) ? template : undefined;
}

import type { Capabilities, SiteConnection } from '@auto-wp/contracts';
import { z } from 'zod';
import { buildItem, type InventoryItem, isNewer, sourceOf } from './item.js';

/**
 * Slugs are passed as argv: no leading `-` (never read as a WP-CLI option) and not `.` or `..` (never a path
 * component).
 */
export const SLUG_PATTERN = /^(?!\.\.?$)[a-z0-9_.][a-z0-9_.-]*$/i;

const CoreCheckUpdate = z.array(
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

export type ShellRunner = (args: readonly string[]) => Promise<string>;

function parseJsonList<T>(stdout: string, schema: z.ZodType<T>, what: string): T {
  const text = stdout.trim();
  if (text === '') return schema.parse([]);
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new Error(`unexpected ${what} output`);
  }
}

/**
 * Detects updates via WP-CLI argv calls. WP-CLI's list output carries no requires-* headers, no
 * package URLs and no plugin dependency slugs, so those fields are left empty on this path.
 */
export async function detectFromShell(
  c: SiteConnection,
  caps: Capabilities,
  warn: (msg: string) => void,
): Promise<InventoryItem[]> {
  const bin = caps.wpCli.path ?? 'wp';
  const run: ShellRunner = async (args) => {
    const r = await c.exec([bin, `--path=${caps.wpRoot}`, '--no-color', ...args]);
    if (r.exitCode !== 0) throw new Error(`wp ${args.slice(0, 2).join(' ')} failed (exit ${r.exitCode})`);
    return r.stdout;
  };

  const current = (await run(['core', 'version'])).trim();
  if (!current) throw new Error('could not determine WordPress core version');

  const items: InventoryItem[] = [];

  const coreUpdates = parseJsonList(
    await run(['core', 'check-update', '--format=json']),
    CoreCheckUpdate,
    'core check-update',
  );
  let best: (typeof coreUpdates)[number] | undefined;
  for (const u of coreUpdates) {
    if (isNewer(u.version, current) && (!best || isNewer(u.version, best.version))) best = u;
  }
  if (best) {
    items.push(
      buildItem({
        type: 'core',
        slug: 'wordpress',
        name: 'WordPress',
        currentVersion: current,
        newVersion: best.version,
        active: true,
        source: sourceOf(best.package_url),
      }),
    );
  }

  const plugins = parseJsonList(
    await run([
      'plugin',
      'list',
      '--fields=name,title,status,version,update_version,update,file',
      '--format=json',
    ]),
    z.array(WpCliPlugin),
    'plugin list',
  );
  for (const p of plugins) {
    if (NEVER_UPDATED.has(p.status) || p.file?.startsWith('mu-plugins/')) continue;
    if (p.update !== 'available' || !p.update_version || !isNewer(p.update_version, p.version)) continue;
    if (!SLUG_PATTERN.test(p.name)) {
      warn('skipping plugin with unexpected slug');
      continue;
    }
    items.push(
      buildItem({
        type: 'plugin',
        slug: p.name,
        name: p.title ?? p.name,
        currentVersion: p.version,
        newVersion: p.update_version,
        active: p.status === 'active' || p.status === 'active-network',
        source: 'unknown',
        requiresPlugins: [],
      }),
    );
  }

  const themes = parseJsonList(
    await run(['theme', 'list', '--fields=name,title,status,version,update_version,update', '--format=json']),
    z.array(WpCliTheme),
    'theme list',
  );
  for (const t of themes) {
    if (t.update !== 'available' || !t.update_version || !isNewer(t.update_version, t.version)) continue;
    if (!SLUG_PATTERN.test(t.name)) {
      warn('skipping theme with unexpected slug');
      continue;
    }
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
      }),
    );
  }

  return items;
}

/** Parent slug for a child theme. Undefined when the theme is its own template or the lookup fails. */
async function parentOfTheme(
  c: SiteConnection,
  bin: string,
  wpRoot: string,
  slug: string,
): Promise<string | undefined> {
  const r = await c.exec([bin, `--path=${wpRoot}`, '--no-color', 'theme', 'get', slug, '--field=template']);
  if (r.exitCode !== 0) return undefined;
  const template = r.stdout.trim();
  return template && template !== slug && SLUG_PATTERN.test(template) ? template : undefined;
}

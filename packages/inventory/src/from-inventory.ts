import { type WpInventory, WpInventorySchema } from '@auto-wp/contracts';
import { buildItem, type InventoryItem, isNewer, sourceOf } from './item.js';

/** Maps a `wp.inventory` agent result (WordPress bridge, full metadata) to update items. */
export function itemsFromInventory(raw: unknown): InventoryItem[] {
  const inv: WpInventory = WpInventorySchema.parse(raw);
  const items: InventoryItem[] = [];

  const core = inv.core;
  if (core.update && isNewer(core.update.version, core.version)) {
    items.push(
      buildItem({
        type: 'core',
        slug: 'wordpress',
        name: 'WordPress',
        currentVersion: core.version,
        newVersion: core.update.version,
        active: true,
        source: sourceOf(core.update.package),
        ...(core.update.requiresWp ? { requiresWp: core.update.requiresWp } : {}),
        ...(core.update.requiresPhp ? { requiresPhp: core.update.requiresPhp } : {}),
      }),
    );
  }

  for (const p of inv.plugins) {
    const update = p.update;
    if (p.updateUri === 'false' || !update || !isNewer(update.version, p.version)) continue;
    if (p.file.startsWith('mu-plugins/')) continue;
    items.push(
      buildItem({
        type: 'plugin',
        slug: p.slug,
        name: p.name,
        currentVersion: p.version,
        newVersion: update.version,
        active: p.active || p.networkActive,
        source: sourceOf(update.package),
        requiresPlugins: p.requiresPlugins,
        ...(update.requiresWp ? { requiresWp: update.requiresWp } : {}),
        ...(update.requiresPhp ? { requiresPhp: update.requiresPhp } : {}),
      }),
    );
  }

  for (const t of inv.themes) {
    const update = t.update;
    if (!update || !isNewer(update.version, t.version)) continue;
    items.push(
      buildItem({
        type: 'theme',
        slug: t.slug,
        name: t.name,
        currentVersion: t.version,
        newVersion: update.version,
        active: t.active,
        source: sourceOf(update.package),
        ...(t.parent && t.parent !== t.slug ? { parentTheme: t.parent } : {}),
        ...(update.requiresWp ? { requiresWp: update.requiresWp } : {}),
        ...(update.requiresPhp ? { requiresPhp: update.requiresPhp } : {}),
      }),
    );
  }

  return items;
}

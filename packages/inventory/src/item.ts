import type { ItemType, UpdateItem } from '@auto-wp/contracts';
import { versionCompare } from './version-compare.js';

/**
 * UpdateItem plus the plugin `Requires Plugins` slugs the planner needs for dependency ordering.
 * The shared UpdateItemSchema has no such field, so it is carried on the object only (zod parsing strips it).
 */
export type InventoryItem = UpdateItem & { requiresPlugins?: string[] };

/** Core: x.y changed. Plugins/themes: first numeric segment changed. */
export function isMajorChange(type: ItemType, from: string, to: string): boolean {
  const head = (s: string | undefined): string => (s ?? '').match(/^\d+/)?.[0] ?? s ?? '';
  const [a0, a1] = from.split('.');
  const [b0, b1] = to.split('.');
  if (type === 'core') return head(a0) !== head(b0) || head(a1) !== head(b1);
  return head(a0) !== head(b0);
}

const WPORG_HOST = 'downloads.wordpress.org';

export function sourceOf(packageUrl: string | undefined): UpdateItem['source'] {
  if (!packageUrl) return 'unknown';
  try {
    return new URL(packageUrl).hostname === WPORG_HOST ? 'wporg' : 'premium';
  } catch {
    return 'unknown';
  }
}

/** True when `to` is strictly newer than `from` under PHP version_compare rules. */
export const isNewer = (to: string, from: string): boolean => versionCompare(to, from) > 0;

export function buildItem(input: Omit<InventoryItem, 'isMajor'>): InventoryItem {
  return { ...input, isMajor: isMajorChange(input.type, input.currentVersion, input.newVersion) };
}

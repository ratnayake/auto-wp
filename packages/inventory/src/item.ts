import type { ItemType, UpdateItem } from '@auto-wp/contracts';
import { versionCompare } from './version-compare.js';

/**
 * @deprecated Use `UpdateItem` from contracts; `requiresPlugins` is part of `UpdateItemSchema` now.
 */
export type InventoryItem = UpdateItem;

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

export function buildItem(input: Omit<UpdateItem, 'isMajor'>): UpdateItem {
  return { ...input, isMajor: isMajorChange(input.type, input.currentVersion, input.newVersion) };
}

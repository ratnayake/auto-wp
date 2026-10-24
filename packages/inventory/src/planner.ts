import { type Capabilities, itemKey, type Policy, type UpdateItem } from '@auto-wp/contracts';
import { type InventoryItem, isNewer } from './item.js';
import { topoSort } from './topo.js';
import { versionCompare } from './version-compare.js';

const CORE_KEY = 'core:wordpress';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pluginOrder = (a: InventoryItem, b: InventoryItem): number =>
  Number(!a.active) - Number(!b.active) || byString(a.slug, b.slug);
const themeOrder = (a: InventoryItem, b: InventoryItem): number => byString(a.slug, b.slug);
// Dependency lists use itemKey form so they match the keys handed to topoSort.
const requiredPlugins = (i: InventoryItem): string[] => (i.requiresPlugins ?? []).map((s) => `plugin:${s}`);
const parentOf = (i: InventoryItem): string[] => (i.parentTheme ? [`theme:${i.parentTheme}`] : []);

const withoutHold = (i: InventoryItem): UpdateItem => {
  const { heldReason: _previous, ...rest } = i;
  return rest;
};

function holdReasonFor(
  i: InventoryItem,
  caps: Capabilities,
  policy: Policy,
  targetCore: string | undefined,
): string | undefined {
  if (i.requiresPhp && versionCompare(i.requiresPhp, caps.phpVersion) > 0) {
    return `requires PHP ${i.requiresPhp} (site runs ${caps.phpVersion})`;
  }
  if (i.type !== 'core' && i.requiresWp && targetCore && versionCompare(i.requiresWp, targetCore) > 0) {
    return `requires WordPress ${i.requiresWp} (target core ${targetCore})`;
  }
  if (policy.holds.includes(itemKey(i))) return 'held by policy';
  return undefined;
}

/**
 * Orders updates for application. Held items are returned last with `heldReason` set; inactive items are
 * dropped when `policy.updateInactive` is false.
 *
 * Order: core minor, plugins (dependencies first, active first, slug), themes (parent first), core major,
 * then items that need the new core (requiresWp above the installed core).
 */
export function planUpdates(items: InventoryItem[], caps: Capabilities, policy: Policy): UpdateItem[] {
  const core = items.find((i) => i.type === 'core');
  const currentCore = core?.currentVersion;
  const targetCore = core?.newVersion;

  const candidates = items.filter((i) => i.type === 'core' || policy.updateInactive || i.active);

  const holds = new Map<string, string>();
  for (const i of candidates) {
    const reason = holdReasonFor(i, caps, policy, targetCore);
    if (reason) holds.set(itemKey(i), reason);
  }
  // With the core update held, anything needing a newer core than the installed one cannot be applied.
  if (holds.has(CORE_KEY) && currentCore) {
    for (const i of candidates) {
      const key = itemKey(i);
      if (i.type !== 'core' && i.requiresWp && isNewer(i.requiresWp, currentCore) && !holds.has(key)) {
        holds.set(key, `requires WordPress ${i.requiresWp}; core update is held`);
      }
    }
  }

  const live = candidates.filter((i) => !holds.has(itemKey(i)));
  const needsNewCore = (i: InventoryItem): boolean =>
    i.type !== 'core' && !!currentCore && !!i.requiresWp && isNewer(i.requiresWp, currentCore);

  // Items needing the new core run after core major. Their dependents follow them.
  const deferred = new Set(live.filter(needsNewCore).map(itemKey));
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of live) {
      const key = itemKey(i);
      if (deferred.has(key) || i.type === 'core') continue;
      const dependsOnDeferred = (i.type === 'plugin' ? requiredPlugins(i) : parentOf(i)).some((d) =>
        deferred.has(d),
      );
      if (dependsOnDeferred) {
        deferred.add(key);
        changed = true;
      }
    }
  }

  const undeferred = (type: UpdateItem['type']) =>
    live.filter((i) => i.type === type && !deferred.has(itemKey(i)));
  const plugins = topoSort(undeferred('plugin'), itemKey, requiredPlugins, pluginOrder);
  const themes = topoSort(undeferred('theme'), itemKey, parentOf, themeOrder);
  const latePlugins = topoSort(
    live.filter((i) => i.type === 'plugin' && deferred.has(itemKey(i))),
    itemKey,
    requiredPlugins,
    pluginOrder,
  );
  const lateThemes = topoSort(
    live.filter((i) => i.type === 'theme' && deferred.has(itemKey(i))),
    itemKey,
    parentOf,
    themeOrder,
  );

  const cycleHolds = [...plugins.cyclic, ...themes.cyclic, ...latePlugins.cyclic, ...lateThemes.cyclic];
  const coreItem = live.find((i) => i.type === 'core');
  const coreMinor = coreItem && !coreItem.isMajor ? [coreItem] : [];
  const coreMajor = coreItem?.isMajor ? [coreItem] : [];

  const ordered = [
    ...coreMinor,
    ...plugins.ordered,
    ...themes.ordered,
    ...coreMajor,
    ...latePlugins.ordered,
    ...lateThemes.ordered,
  ].map(withoutHold);

  const held: UpdateItem[] = [
    ...candidates
      .filter((i) => holds.has(itemKey(i)))
      .map((i) => ({ ...withoutHold(i), heldReason: holds.get(itemKey(i)) ?? 'held' })),
    ...cycleHolds.map((i) => ({ ...withoutHold(i), heldReason: 'dependency cycle' })),
  ].sort((a, b) => byString(itemKey(a), itemKey(b)));

  return [...ordered, ...held];
}

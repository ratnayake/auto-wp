import { type Capabilities, itemKey, type Policy, type UpdateItem } from '@auto-wp/contracts';
import { isNewer } from './item.js';
import { topoSort } from './topo.js';
import { versionCompare } from './version-compare.js';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pluginOrder = (a: UpdateItem, b: UpdateItem): number =>
  Number(!a.active) - Number(!b.active) || byString(a.slug, b.slug);
const themeOrder = (a: UpdateItem, b: UpdateItem): number => byString(a.slug, b.slug);
// Dependency lists use itemKey form so they match the keys handed to topoSort.
const requiredPlugins = (i: UpdateItem): string[] => (i.requiresPlugins ?? []).map((s) => `plugin:${s}`);
const parentOf = (i: UpdateItem): string[] => (i.parentTheme ? [`theme:${i.parentTheme}`] : []);

const withoutHold = (i: UpdateItem): UpdateItem => {
  const { heldReason: _previous, ...rest } = i;
  return rest;
};

/**
 * Reasons an item cannot run. `plannedCore` is the WordPress version the site will run after this plan:
 * the core update's newVersion when core is applied, otherwise the installed version (undefined if unknown).
 */
function holdReasonFor(
  i: UpdateItem,
  caps: Capabilities,
  policy: Policy,
  plannedCore: string | undefined,
): string | undefined {
  if (i.requiresPhp && versionCompare(i.requiresPhp, caps.phpVersion) > 0) {
    return `requires PHP ${i.requiresPhp} (site runs ${caps.phpVersion})`;
  }
  if (i.type !== 'core' && i.requiresWp && plannedCore && isNewer(i.requiresWp, plannedCore)) {
    return `requires WordPress ${i.requiresWp} (planned core ${plannedCore})`;
  }
  if (policy.holds.includes(itemKey(i))) return 'held by policy';
  return undefined;
}

/**
 * Orders updates for application. Held items are returned last with `heldReason` set; inactive items are
 * dropped when `policy.updateInactive` is false.
 *
 * Order: core minor, plugins (dependencies first, active first, slug), themes (parent first), core major,
 * then items that need the new core (requiresWp above the installed core, at or below the planned core).
 *
 * `installedCore` is the WordPress version currently installed (from `inspect()`). It defaults to the core
 * item's currentVersion. When neither is known, requiresWp cannot be checked.
 */
export function planUpdates(
  items: UpdateItem[],
  caps: Capabilities,
  policy: Policy,
  installedCore?: string,
): UpdateItem[] {
  const core = items.find((i) => i.type === 'core');
  const installed = installedCore ?? core?.currentVersion;

  const candidates = items.filter((i) => i.type === 'core' || policy.updateInactive || i.active);

  // The core update is applied only if it is not itself held; otherwise the site stays on the installed core.
  const coreReason = core ? holdReasonFor(core, caps, policy, undefined) : undefined;
  const plannedCore = core && !coreReason ? core.newVersion : installed;

  const holds = new Map<string, string>();
  for (const i of candidates) {
    const reason = i.type === 'core' ? coreReason : holdReasonFor(i, caps, policy, plannedCore);
    if (reason) holds.set(itemKey(i), reason);
  }
  const live = candidates.filter((i) => !holds.has(itemKey(i)));

  // Needs a core newer than the installed one, so it must follow the core update. Its dependents follow it.
  const needsNewCore = (i: UpdateItem): boolean =>
    i.type !== 'core' && !!installed && !!i.requiresWp && isNewer(i.requiresWp, installed);
  const deferred = new Set(live.filter(needsNewCore).map(itemKey));
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of live) {
      const key = itemKey(i);
      if (deferred.has(key) || i.type === 'core') continue;
      const deps = i.type === 'plugin' ? requiredPlugins(i) : parentOf(i);
      if (deps.some((d) => deferred.has(d))) {
        deferred.add(key);
        changed = true;
      }
    }
  }

  const undeferred = (type: UpdateItem['type']) =>
    live.filter((i) => i.type === type && !deferred.has(itemKey(i)));
  const plugins = topoSort(undeferred('plugin'), itemKey, requiredPlugins, pluginOrder);
  const themes = topoSort(undeferred('theme'), itemKey, parentOf, themeOrder);

  const deferredOf = (type: UpdateItem['type']) =>
    live.filter((i) => i.type === type && deferred.has(itemKey(i)));
  const latePlugins = topoSort(deferredOf('plugin'), itemKey, requiredPlugins, pluginOrder);
  const lateThemes = topoSort(deferredOf('theme'), itemKey, parentOf, themeOrder);

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

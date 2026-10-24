import type { Policy, UpdateItem } from '@auto-wp/contracts';

/** Decides whether an item gets a DB snapshot before it is updated. `dbSizeMb` is undefined when unknown. */
export type NeedsDbSnapshot = (item: UpdateItem, dbSizeMb: number | undefined, policy: Policy) => boolean;

/**
 * `always` / `never` / `auto`. Auto snapshots core, the policy's DB-migrating plugins, and anything else when
 * the DB is under `dbSnapshotMaxMb`. An unknown DB size counts as small (fail-safe: take the snapshot).
 */
export const defaultNeedsDbSnapshot: NeedsDbSnapshot = (item, dbSizeMb, policy) => {
  if (policy.dbSnapshot === 'always') return true;
  if (policy.dbSnapshot === 'never') return false;
  if (item.type === 'core') return true;
  if (item.type === 'plugin' && policy.dbMigratingPlugins.includes(item.slug)) return true;
  return dbSizeMb === undefined || dbSizeMb < policy.dbSnapshotMaxMb;
};

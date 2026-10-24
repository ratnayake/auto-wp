import type { ApprovalAction, Policy, UpdateItem } from '@auto-wp/contracts';
import { itemKey } from '@auto-wp/contracts';

export class PolicyEngine {
  constructor(private readonly policy: Policy) {}

  requiresApproval(action: ApprovalAction): boolean {
    return this.policy.requireApproval.includes(action);
  }

  isHeld(key: string): boolean {
    return this.policy.holds.includes(key);
  }

  needsDbSnapshot(item: Pick<UpdateItem, 'type' | 'slug'>, dbSizeMb: number): boolean {
    switch (this.policy.dbSnapshot) {
      case 'always':
        return true;
      case 'never':
        return false;
      case 'auto':
        return (
          item.type === 'core' ||
          this.policy.dbMigratingPlugins.includes(item.slug) ||
          dbSizeMb < this.policy.dbSnapshotMaxMb
        );
    }
  }

  backupFreshEnough(verifiedAt: Date | string, now: Date): boolean {
    const age = now.getTime() - new Date(verifiedAt).getTime();
    return Number.isFinite(age) && age <= this.policy.backupMaxAgeMinutes * 60_000;
  }

  /** Convenience for callers holding an UpdateItem. */
  isItemHeld(item: Pick<UpdateItem, 'type' | 'slug'>): boolean {
    return this.isHeld(itemKey(item));
  }
}

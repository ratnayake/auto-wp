import {
  type Capabilities,
  type InventoryService,
  type Logger,
  type Policy,
  type SiteConnection,
  type UpdateItem,
  WpInventorySchema,
} from '@auto-wp/contracts';
import { itemsFromInventory } from './from-inventory.js';
import { detectFromShell } from './from-shell.js';
import { type InventoryItem } from './item.js';
import { planUpdates } from './planner.js';

/** Detection result. `installedCore` is known even when no core update is pending. */
export interface InventoryDetection {
  installedCore: string;
  items: InventoryItem[];
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class DefaultInventoryService implements InventoryService {
  constructor(private readonly logger: Logger) {}

  /**
   * Installed core version plus items with an update available. Uses WP-CLI over argv when the host allows it.
   * Falls back to the `wp.inventory` agent action when WP-CLI is unavailable or fails.
   */
  async inspect(c: SiteConnection): Promise<InventoryDetection> {
    const caps: Capabilities = await c.probe();
    const siteId = c.siteId;
    if (caps.shell && caps.wpCli.available) {
      try {
        const detection = await detectFromShell(c, caps, {
          warn: (msg) => this.logger.warn({ siteId }, msg),
        });
        this.logger.info({ siteId, path: 'wp-cli', count: detection.items.length }, 'inventory detected');
        return detection;
      } catch (err) {
        this.logger.warn({ siteId, path: 'wp-cli', reason: errorMessage(err) }, 'WP-CLI detection failed');
      }
    }
    const inv = WpInventorySchema.parse(await c.call('wp.inventory', { refresh: true }));
    const items = itemsFromInventory(inv);
    this.logger.info({ siteId, path: 'agent', count: items.length }, 'inventory detected');
    return { installedCore: inv.core.version, items };
  }

  async detect(c: SiteConnection): Promise<UpdateItem[]> {
    return (await this.inspect(c)).items;
  }

  /**
   * Orders and holds items. Pass `installedCore` from `inspect()`; without it the core item's
   * currentVersion is used, and requiresWp is not checked when there is no core item.
   */
  plan(items: UpdateItem[], caps: Capabilities, policy: Policy, installedCore?: string): UpdateItem[] {
    return planUpdates(items, caps, policy, installedCore);
  }
}

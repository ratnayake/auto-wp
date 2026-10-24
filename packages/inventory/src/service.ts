import type {
  Capabilities,
  InventoryService,
  Logger,
  Policy,
  SiteConnection,
  UpdateItem,
} from '@auto-wp/contracts';
import { itemsFromInventory } from './from-inventory.js';
import { detectFromShell } from './from-shell.js';
import { planUpdates } from './planner.js';

export class DefaultInventoryService implements InventoryService {
  constructor(private readonly logger: Logger) {}

  /** Items with an update available. Uses WP-CLI over argv when the host allows it, else the agent bridge. */
  async detect(c: SiteConnection): Promise<UpdateItem[]> {
    const caps = await c.probe();
    const items =
      caps.shell && caps.wpCli.available
        ? await detectFromShell(c, caps, (msg) => this.logger.warn({ siteId: c.siteId }, msg))
        : itemsFromInventory(await c.call('wp.inventory', { refresh: true }));
    this.logger.info(
      {
        siteId: c.siteId,
        path: caps.shell && caps.wpCli.available ? 'wp-cli' : 'agent',
        count: items.length,
      },
      'inventory detected',
    );
    return items;
  }

  plan(items: UpdateItem[], caps: Capabilities, policy: Policy): UpdateItem[] {
    return planUpdates(items, caps, policy);
  }
}

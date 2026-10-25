import { type AppConfig, AppConfigSchema } from '@auto-wp/contracts';
import { createFakeServices, type Services } from './container.js';

/**
 * Production wiring. Until the real packages land on main this returns fakes, so the server runs but
 * talks to no real site.
 *
 * TODO(wire): replace each fake below with the real implementation, one import per package:
 *   - @auto-wp/config       -> SecretStore, config loading (replaces `config`), connection registry
 *   - @auto-wp/safety       -> AuditLog (append-only file), ApprovalGate, locks, Policy evaluation
 *   - @auto-wp/transport-ssh, @auto-wp/transport-agent -> ConnectionFactory (choose by site.transport.kind)
 *   - @auto-wp/backup       -> BackupService
 *   - @auto-wp/verify       -> BackupVerifier
 *   - @auto-wp/inventory    -> InventoryService
 *   - @auto-wp/vulndb       -> VulnService
 *   - @auto-wp/updater      -> Updater, RestoreService
 *   - @auto-wp/health       -> HealthChecker
 *   - @auto-wp/report       -> Reporter
 * RunStore should persist under config.stateDir (the in-memory store loses runs on restart).
 */
export function createServices(
  config: AppConfig = AppConfigSchema.parse({ sites: [] }),
  overrides: Partial<Services> = {},
): Services {
  return createFakeServices({ config, defaultActor: 'stdio', ...overrides });
}

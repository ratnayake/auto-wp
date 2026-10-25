import {
  type AppConfig,
  AppConfigSchema,
  type ApprovalGate,
  type AuditLog,
  type BackupService,
  type BackupVerifier,
  type Clock,
  type ConnectionFactory,
  type HealthChecker,
  type InventoryService,
  type Logger,
  type Reporter,
  type RestoreService,
  type RunStore,
  type SiteConfig,
  type Updater,
  type VulnService,
} from '@auto-wp/contracts';
import {
  FakeClock,
  FakeSiteConnection,
  InMemoryAuditLog,
  InMemoryRunStore,
  MemoryLogger,
} from '@auto-wp/contracts/fakes';
import {
  StubBackupService,
  StubHealth,
  StubInventory,
  StubReporter,
  StubRestore,
  StubUpdater,
  StubVerifier,
  StubVulnService,
} from './stubs.js';

/** Everything the MCP server needs, injected so the server is testable without real sites. */
export interface Services {
  config: AppConfig;
  connectionFactory: ConnectionFactory;
  backup: BackupService;
  verifier: BackupVerifier;
  inventory: InventoryService;
  vulns: VulnService;
  health: HealthChecker;
  updater: Updater;
  restore: RestoreService;
  /** Out-of-band approval (CLI prompt, chat bot...). Used when the MCP client cannot elicit. Optional. */
  approvalGate?: ApprovalGate;
  audit: AuditLog;
  runStore: RunStore;
  reporter: Reporter;
  clock: Clock;
  logger: Logger;
  /** Audit actor when the transport gives no identity (stdio). */
  defaultActor?: string;
}

export const DEMO_SITE: SiteConfig = {
  id: 'demo',
  name: 'Demo Site',
  url: 'https://demo.example.com',
  transport: {
    kind: 'ssh',
    host: 'demo.example.com',
    port: 22,
    username: 'demo',
    hostKeySha256: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    wpRoot: '/var/www/html',
    phpBinary: 'php',
    toolDir: '~/.auto-wp',
  },
  healthUrls: ['/'],
  maskSelectors: [],
  backupLocation: 'docroot',
  offsite: { encryptDb: false },
  logFiles: [],
  policy: {},
};

export type FakeServices = Services & {
  clock: FakeClock;
  audit: InMemoryAuditLog;
  runStore: InMemoryRunStore;
  logger: MemoryLogger;
  backup: StubBackupService;
};

/** Builds a fully working Services from contracts fakes plus in-package stubs. */
export function createFakeServices(overrides: Partial<Services> = {}): FakeServices {
  const clock = new FakeClock('2026-10-24T10:00:00Z');
  const backup = new StubBackupService(clock);
  const base: FakeServices = {
    config: AppConfigSchema.parse({ sites: [DEMO_SITE] }),
    connectionFactory: {
      async open(site) {
        return new FakeSiteConnection(site.id).onCall('wp.maintenance', async (p) => ({
          enabled: (p as { enabled: boolean }).enabled,
        }));
      },
    },
    backup,
    verifier: new StubVerifier(backup, clock),
    inventory: new StubInventory(),
    vulns: new StubVulnService(),
    health: new StubHealth(clock),
    updater: new StubUpdater(clock),
    restore: new StubRestore(clock),
    audit: new InMemoryAuditLog(),
    runStore: new InMemoryRunStore(),
    reporter: new StubReporter(),
    clock,
    logger: new MemoryLogger(),
  };
  return Object.assign(base, overrides) as FakeServices;
}

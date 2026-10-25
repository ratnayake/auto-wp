import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultBackupService } from '@auto-wp/backup';
import { createSecretStore, EnvOverlaySecretStore } from '@auto-wp/config';
import {
  type AppConfig,
  AppConfigSchema,
  type ApprovalGate,
  type Clock,
  type ConnectionFactory,
  type Logger,
  type SecretStore,
  type SiteConfig,
  type SiteConnection,
  type VulnProvider,
} from '@auto-wp/contracts';
import { type BrowserFactory, DefaultHealthChecker, launchChromium } from '@auto-wp/health';
import { DefaultInventoryService } from '@auto-wp/inventory';
import { DefaultReporter } from '@auto-wp/report';
import { EnvApprovalGate, FileAuditLog, TtyApprovalGate } from '@auto-wp/safety';
import { AgentConnectionFactory } from '@auto-wp/transport-agent';
import { SshConnectionFactory } from '@auto-wp/transport-ssh';
import { DefaultRestoreService, DefaultUpdater } from '@auto-wp/updater';
import { CliDockerRunner, DefaultBackupVerifier } from '@auto-wp/verify';
import { DefaultVulnService, WordfenceProvider, WpscanProvider } from '@auto-wp/vulndb';
import pino from 'pino';
import { createFakeServices, type Services } from './container.js';
import { FileRunStore } from './run-store.js';

type Env = Record<string, string | undefined>;

/** `AUTOWP_FAKE=1` forces the in-process fakes (no site is ever contacted). */
export const isFakeMode = (env: Env = process.env): boolean => env.AUTOWP_FAKE === '1';

/** `agent-php/dist/agent.php` in this checkout, or `$AUTOWP_AGENT_PHP`. */
export function agentPhpPath(env: Env = process.env): string {
  return env.AUTOWP_AGENT_PHP || fileURLToPath(new URL('../../../agent-php/dist/agent.php', import.meta.url));
}

const systemClock: Clock = { now: () => new Date() };

function stderrLogger(env: Env): Logger {
  return pino(
    {
      level: env.AUTOWP_LOG_LEVEL ?? 'info',
      redact: ['token', 'authorization', '*.token', '*.authorization'],
    },
    pino.destination(2),
  );
}

/**
 * Opens a site with the transport its config names. `sftp+agent` (SFTP for files, signed agent for
 * actions) has no implementation yet and is refused with a clear message.
 */
export class TransportConnectionFactory implements ConnectionFactory {
  constructor(
    private readonly ssh: ConnectionFactory,
    private readonly agent: ConnectionFactory,
  ) {}

  open(site: SiteConfig): Promise<SiteConnection> {
    switch (site.transport.kind) {
      case 'ssh':
        return this.ssh.open(site);
      case 'agent':
        return this.agent.open(site);
      default:
        return Promise.reject(
          new Error(
            `site "${site.id}": transport "${site.transport.kind}" is not supported yet; use "ssh" or "agent"`,
          ),
        );
    }
  }
}

/** Playwright when installed and launchable; after the first failed launch, snapshots stay HTTP-only. */
function optionalBrowser(env: Env, logger: Logger): BrowserFactory | undefined {
  if (env.AUTOWP_PLAYWRIGHT === '0') return undefined;
  let failed: unknown;
  return async () => {
    if (failed) throw failed;
    try {
      return await launchChromium();
    } catch (err) {
      failed = err;
      logger.warn(
        { err: String(err).split('\n')[0] },
        'Playwright/Chromium unavailable; health snapshots are HTTP-only (set AUTOWP_PLAYWRIGHT=0 to silence)',
      );
      throw err;
    }
  };
}

/** Out-of-band approval used when the MCP client cannot elicit: env (tests only) or the controlling TTY. */
function approvalGate(env: Env, logger: Logger, clock: Clock): ApprovalGate | undefined {
  if (env.AUTOWP_TEST_APPROVE === '1') return new EnvApprovalGate(logger, env as NodeJS.ProcessEnv, clock);
  try {
    closeSync(openSync('/dev/tty', 'r+'));
    return new TtyApprovalGate(undefined, clock);
  } catch {
    return undefined;
  }
}

function vulnProviders(config: AppConfig, secrets: SecretStore, env: Env, logger: Logger, clock: Clock) {
  const cacheDir = join(config.dataDir, 'vulndb');
  const v = config.vulndb;
  const minRecords = env.AUTOWP_WORDFENCE_MIN_RECORDS ? Number(env.AUTOWP_WORDFENCE_MIN_RECORDS) : undefined;
  const providers: VulnProvider[] = [
    new WordfenceProvider({
      cacheDir,
      clock,
      logger,
      feedUrl: env.AUTOWP_WORDFENCE_FEED_URL || v.wordfenceFeedUrl,
      apiKey: v.wordfenceApiKeyRef ? () => secrets.get(v.wordfenceApiKeyRef as string) : undefined,
      ...(minRecords !== undefined && Number.isInteger(minRecords) && minRecords >= 0 ? { minRecords } : {}),
    }),
  ];
  if (v.wpscanTokenRef) {
    const ref = v.wpscanTokenRef;
    providers.push(
      new WpscanProvider({
        token: () => secrets.get(ref),
        cacheDir,
        clock,
        logger,
        baseUrl: v.wpscanBaseUrl,
      }),
    );
  }
  return providers;
}

export interface CreateServicesOptions {
  env?: Env;
  /** Source of agent.php for the SSH transport (default: read `agentPhpPath()`). */
  agentPhpSource?: () => Promise<Buffer>;
  secrets?: SecretStore;
}

/**
 * Production wiring: the real packages behind the service seams. `overrides` replace individual services
 * (tests pass a fake ConnectionFactory). With `AUTOWP_FAKE=1` everything is faked.
 */
export async function createServices(
  config: AppConfig = AppConfigSchema.parse({ sites: [] }),
  overrides: Partial<Services> = {},
  o: CreateServicesOptions = {},
): Promise<Services> {
  const env = o.env ?? process.env;
  if (isFakeMode(env)) return createFakeServices({ config, defaultActor: 'stdio', ...overrides });

  const logger = overrides.logger ?? stderrLogger(env);
  const clock = overrides.clock ?? systemClock;
  const secrets =
    o.secrets ??
    new EnvOverlaySecretStore(
      () => createSecretStore({ env, secretsFile: join(config.dataDir, 'secrets.enc') }),
      env,
    );

  let agentPhp: Promise<Buffer> | undefined;
  const agentPhpSource =
    o.agentPhpSource ??
    (() => {
      agentPhp ??= readFile(agentPhpPath(env)).catch((err) => {
        agentPhp = undefined;
        throw new Error(
          `cannot read agent.php at ${agentPhpPath(env)} (build it with \`php agent-php/bin/build.php\` or set AUTOWP_AGENT_PHP): ${(err as Error).message}`,
        );
      });
      return agentPhp;
    });

  const connectionFactory =
    overrides.connectionFactory ??
    new TransportConnectionFactory(
      new SshConnectionFactory({ logger, agentPhpSource }),
      new AgentConnectionFactory({ secrets, logger, clock }),
    );

  const runStore = overrides.runStore ?? new FileRunStore(config.stateDir, logger);
  const health =
    overrides.health ??
    new DefaultHealthChecker({
      logger,
      clock,
      artifactsDir: join(config.dataDir, 'health'),
      browser: optionalBrowser(env, logger),
    });

  return {
    config,
    connectionFactory,
    backup: new DefaultBackupService({
      logger,
      clock,
      fetch,
      dataDir: config.dataDir,
      policy: config.policy,
    }),
    verifier: new DefaultBackupVerifier({
      logger,
      clock,
      dataDir: config.dataDir,
      dockerRunner: new CliDockerRunner(),
    }),
    inventory: new DefaultInventoryService(logger),
    vulns: new DefaultVulnService(vulnProviders(config, secrets, env, logger, clock), logger),
    health,
    // The updater checkpoints its own progress (resumable runs) in a separate store: sharing the server's
    // run records would let it publish a terminal status while the run manager is still finishing the run.
    updater: new DefaultUpdater({
      health,
      runs: new FileRunStore(join(config.stateDir, 'updater-checkpoints'), logger),
      logger,
      clock,
    }),
    restore: new DefaultRestoreService({ logger, clock }),
    approvalGate: approvalGate(env, logger, clock),
    audit: new FileAuditLog(config.stateDir),
    runStore,
    reporter: new DefaultReporter(),
    clock,
    logger,
    defaultActor: 'stdio',
    ...overrides,
  };
}

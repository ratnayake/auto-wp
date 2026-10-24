import { z } from 'zod';
import { ThresholdsSchema } from './domain.js';

/** Reference to a secret held by the SecretStore (packages/config), never the secret itself. */
export const SecretRefSchema = z.string().regex(/^secret:[a-z0-9][a-z0-9._/-]*$/i, 'expected secret:<name>');
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const SshTransportConfigSchema = z.object({
  kind: z.literal('ssh'),
  host: z.string(),
  port: z.number().int().default(22),
  username: z.string(),
  /** `SHA256:<base64>` fingerprint pinned at registration. Connections with another key are refused. */
  hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/=]+$/),
  /** Absolute WordPress root on the server. */
  wpRoot: z.string(),
  phpBinary: z.string().default('php'),
  /** Remote dir for agent.php / wp-cli.phar, outside the docroot. */
  toolDir: z.string().default('~/.auto-wp'),
});

export const AgentTransportConfigSchema = z.object({
  kind: z.literal('agent'),
  /** Full URL of the deployed agent, e.g. https://example.com/auto-wp-agent/agent.php */
  endpoint: z.url(),
  keyId: z.string(),
  /** Ed25519 private key (base64 32-byte seed) or HMAC key, in the SecretStore. */
  signingKeyRef: SecretRefSchema,
  algorithm: z.enum(['ed25519', 'hmac-sha256']).default('ed25519'),
  /** Expected sha256 of agent.php; connection refused on mismatch. */
  agentSha256: z.string().optional(),
  /** Allow plain http:// only for loopback hosts (tests). */
  insecureHttpLoopback: z.boolean().default(false),
});

export const SftpAgentTransportConfigSchema = z.object({
  kind: z.literal('sftp+agent'),
  sftp: SshTransportConfigSchema.omit({ kind: true }),
  agent: AgentTransportConfigSchema.omit({ kind: true }),
});

export const TransportConfigSchema = z.discriminatedUnion('kind', [
  SshTransportConfigSchema,
  AgentTransportConfigSchema,
  SftpAgentTransportConfigSchema,
]);
export type TransportConfig = z.infer<typeof TransportConfigSchema>;

export const ApprovalActionSchema = z.enum([
  'restore.execute',
  'backup.prune',
  'update.core-major',
  'update.apply',
  'maintenance.set',
]);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const PolicySchema = z.object({
  requireApproval: z
    .array(ApprovalActionSchema)
    .default(['restore.execute', 'backup.prune', 'update.core-major']),
  /** DB snapshot before each item: always, never, or auto (core + listed plugins, or DB under size limit). */
  dbSnapshot: z.enum(['always', 'never', 'auto']).default('auto'),
  dbSnapshotMaxMb: z.number().default(200),
  dbMigratingPlugins: z.array(z.string()).default(['woocommerce', 'elementor', 'wordpress-seo', 'yoast-seo']),
  backupMaxAgeMinutes: z.number().default(60),
  /** `type:slug` keys never updated automatically. */
  holds: z.array(z.string()).default([]),
  updateInactive: z.boolean().default(true),
  thresholds: ThresholdsSchema.default({ pixelDiffPct: 2, slowdownFactor: 1.5, slowdownMinMs: 300 }),
  retention: z
    .object({ remote: z.number().int().default(3), local: z.number().int().default(14) })
    .default({ remote: 3, local: 14 }),
});
export type Policy = z.infer<typeof PolicySchema>;

export const SiteConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  url: z.url(),
  transport: TransportConfigSchema,
  /** Paths (relative to url) or absolute URLs checked before/after updates. Homepage is always included. */
  healthUrls: z.array(z.string()).default(['/', '/wp-login.php', '/wp-json/']),
  /** CSS selectors masked in screenshots (sliders, dates, ads). */
  maskSelectors: z.array(z.string()).default([]),
  /** Where backups live: `docroot` = <wpRoot>/auto-wp-backup (default, per requirements), `outside` = above docroot. */
  backupLocation: z.enum(['docroot', 'outside']).default('docroot'),
  offsite: z
    .object({
      dir: z.string().optional(),
      rcloneRemote: z.string().optional(),
      encryptDb: z.boolean().default(false),
    })
    .default({ encryptDb: false }),
  /** Remote log files to scan for PHP fatals, relative to wpRoot. */
  logFiles: z.array(z.string()).default(['wp-content/debug.log', 'error_log']),
  policy: PolicySchema.partial().default({}),
});
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

export const AppConfigSchema = z.object({
  sites: z.array(SiteConfigSchema),
  policy: PolicySchema.default(PolicySchema.parse({})),
  stateDir: z.string().default('~/.local/state/auto-wp'),
  dataDir: z.string().default('~/.local/share/auto-wp'),
  vulndb: z
    .object({
      wordfenceApiKeyRef: SecretRefSchema.optional(),
      wordfenceFeedUrl: z.url().optional(),
      wpscanTokenRef: SecretRefSchema.optional(),
      wpscanBaseUrl: z.url().optional(),
    })
    .default({}),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

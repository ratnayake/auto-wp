import type { ApprovalAction, Policy, SiteConfig } from './config.js';
import type { Capabilities, SiteConnection } from './connection.js';
import type {
  BackupManifest,
  ComparisonResult,
  HealthSnapshot,
  ItemResult,
  ItemType,
  ItemVulnAssessment,
  Report,
  RunRecord,
  Thresholds,
  UpdateItem,
  VerificationResult,
  Vulnerability,
} from './domain.js';

/**
 * Service seams. Each package implements one of these; apps/mcp-server wires them together.
 * Packages must depend only on these interfaces, never on a sibling package's implementation.
 */

export interface Clock {
  now(): Date;
}

export interface Logger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface SecretStore {
  get(ref: string): Promise<string>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export interface ConnectionFactory {
  open(site: SiteConfig): Promise<SiteConnection>;
}

export interface BackupCreateOptions {
  dryRun?: boolean;
  /** Copy artifacts off-server after creation (default true). */
  pull?: boolean;
  onProgress?(message: string): void;
}

export interface BackupService {
  create(site: SiteConfig, c: SiteConnection, o?: BackupCreateOptions): Promise<BackupManifest>;
  list(site: SiteConfig, c: SiteConnection): Promise<BackupManifest[]>;
  pull(site: SiteConfig, c: SiteConnection, backupId: string): Promise<{ localDir: string }>;
  prune(
    site: SiteConfig,
    c: SiteConnection,
    keep: number,
    o?: { dryRun?: boolean },
  ): Promise<{ removed: string[] }>;
}

export interface BackupVerifier {
  verify(
    site: SiteConfig,
    c: SiteConnection,
    backupId: string,
    o?: { deep?: boolean },
  ): Promise<VerificationResult>;
}

export interface InventoryDetection {
  /** Installed WordPress version, known even when no core update is pending. */
  installedCore: string;
  items: UpdateItem[];
}

export interface InventoryService {
  detect(c: SiteConnection): Promise<UpdateItem[]>;
  /** Like `detect`, plus the installed core version (used by `plan` to check `requiresWp`). Optional. */
  inspect?(c: SiteConnection): Promise<InventoryDetection>;
  /**
   * Orders items and marks held ones (`heldReason`). `installedCore` (from `inspect`) lets `requiresWp` be
   * checked when no core update is pending.
   */
  plan(items: UpdateItem[], caps: Capabilities, policy: Policy, installedCore?: string): UpdateItem[];
}

export interface VulnProvider {
  readonly name: 'wordfence' | 'wpscan' | 'patchstack';
  lookup(type: ItemType, slug: string, hint?: { versions?: string[] }): Promise<Vulnerability[]>;
}

export interface VulnService {
  assess(items: UpdateItem[]): Promise<ItemVulnAssessment[]>;
  /** Attribution strings that must appear in reports (e.g. Wordfence feed license). */
  attributions(): string[];
}

export interface HealthChecker {
  /**
   * @param o.bypassToken maintenance-mode bypass cookie value; send it when the site is in maintenance mode
   */
  snapshot(
    site: SiteConfig,
    c: SiteConnection,
    label: string,
    o?: {
      /** maintenance-mode bypass cookie value; send it when the site is in maintenance mode */
      bypassToken?: string;
    },
  ): Promise<HealthSnapshot>;
  /**
   * Fast check against a baseline: HTTP, critical-error marker, new log fatals. No screenshots.
   * @param o.bypassToken maintenance-mode bypass cookie value; send it when the site is in maintenance mode
   */
  quick(
    site: SiteConfig,
    c: SiteConnection,
    baseline: HealthSnapshot,
    o?: {
      /** maintenance-mode bypass cookie value; send it when the site is in maintenance mode */
      bypassToken?: string;
    },
  ): Promise<ComparisonResult>;
  compare(before: HealthSnapshot, after: HealthSnapshot, t: Thresholds): Promise<ComparisonResult>;
}

export interface MaintenanceService {
  set(
    site: SiteConfig,
    c: SiteConnection,
    enabled: boolean,
    o?: { bypassToken?: string },
  ): Promise<{ enabled: boolean }>;
}

export interface UpdaterOptions {
  runId: string;
  dryRun?: boolean;
  baseline: HealthSnapshot;
  policy: Policy;
}

export interface Updater {
  apply(
    site: SiteConfig,
    c: SiteConnection,
    plan: UpdateItem[],
    o: UpdaterOptions,
  ): AsyncIterable<ItemResult>;
}

export interface RestorePlan {
  planHash: string;
  siteId: string;
  backupId: string;
  scope: 'full' | 'db' | 'files';
  steps: string[];
  createdAt: string;
}

export interface RestoreService {
  plan(
    site: SiteConfig,
    c: SiteConnection,
    backupId: string,
    scope: RestorePlan['scope'],
  ): Promise<RestorePlan>;
  /** Caller must have obtained approval for `plan.planHash` first. */
  execute(
    site: SiteConfig,
    c: SiteConnection,
    plan: RestorePlan,
    approval: ApprovalResult,
  ): Promise<VerificationResult>;
}

export interface ApprovalRequest {
  action: ApprovalAction;
  siteId: string;
  summary: string;
  planHash: string;
}
export interface ApprovalResult {
  approved: boolean;
  by: string;
  planHash: string;
  at: string;
}
export interface ApprovalGate {
  request(r: ApprovalRequest): Promise<ApprovalResult>;
}

export interface AuditEntry {
  ts: string;
  actor: string;
  siteId?: string;
  action: string;
  dryRun: boolean;
  data?: unknown;
}
export interface AuditLog {
  append(e: AuditEntry): Promise<void>;
  tail(limit: number): Promise<AuditEntry[]>;
}

export interface RunStore {
  save(r: RunRecord): Promise<void>;
  get(runId: string): Promise<RunRecord | undefined>;
  list(siteId?: string): Promise<RunRecord[]>;
}

export interface Reporter {
  render(r: Report, format: 'json' | 'md' | 'html'): Promise<string>;
}

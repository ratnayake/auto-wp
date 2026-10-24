import { z } from 'zod';

export const ItemTypeSchema = z.enum(['core', 'plugin', 'theme']);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const UpdateItemSchema = z.object({
  type: ItemTypeSchema,
  /** `wordpress` for core. */
  slug: z.string(),
  name: z.string(),
  currentVersion: z.string(),
  newVersion: z.string(),
  active: z.boolean(),
  source: z.enum(['wporg', 'premium', 'unknown']),
  requiresWp: z.string().optional(),
  requiresPhp: z.string().optional(),
  parentTheme: z.string().optional(),
  /** Core: x.y changed. Plugins/themes: first numeric segment changed. */
  isMajor: z.boolean(),
  /** Planner annotation: why the item is held back, if it is. */
  heldReason: z.string().optional(),
});
export type UpdateItem = z.infer<typeof UpdateItemSchema>;

/** Stable key used in tool inputs, e.g. `plugin:contact-form-7`, `core:wordpress`. */
export const itemKey = (i: Pick<UpdateItem, 'type' | 'slug'>): string => `${i.type}:${i.slug}`;

export const BackupArtifactSchema = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  encrypted: z.boolean().optional(),
});

export const BackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  /** Run folder name: `<ISO basic UTC>-<6 hex>`, e.g. `20261024T103012Z-7f3a9c`. */
  backupId: z.string(),
  siteId: z.string(),
  createdAt: z.string(),
  toolVersion: z.string(),
  /** Absolute remote directory holding the artifacts. */
  location: z.string(),
  wp: z.object({ core: z.string(), php: z.string(), db: z.string() }),
  method: z.object({ db: z.enum(['wpcli', 'mysqldump', 'native']), files: z.enum(['tar', 'native']) }),
  db: z.object({
    tables: z.array(z.object({ name: z.string(), rows: z.number().int() })),
    charset: z.string(),
  }),
  files: z.object({ count: z.number().int(), bytes: z.number().int(), excludes: z.array(z.string()) }),
  /** Conventional names: `db.sql.gz`, `files.tar.gz`. */
  artifacts: z.array(BackupArtifactSchema),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export const CheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  severity: z.enum(['error', 'warn', 'info']),
  details: z.unknown().optional(),
});
export type Check = z.infer<typeof CheckSchema>;

export const VerificationResultSchema = z.object({
  backupId: z.string(),
  ok: z.boolean(),
  verifiedAt: z.string(),
  checks: z.array(CheckSchema),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const VersionRangeSchema = z.object({
  from: z.string(),
  fromInclusive: z.boolean(),
  to: z.string(),
  toInclusive: z.boolean(),
});
export type VersionRange = z.infer<typeof VersionRangeSchema>;

export const VulnerabilitySchema = z.object({
  id: z.string(),
  source: z.enum(['wordfence', 'wpscan', 'patchstack']),
  cve: z.string().optional(),
  title: z.string(),
  cvss: z.object({ score: z.number(), rating: z.string(), vector: z.string().optional() }).optional(),
  affected: z.array(VersionRangeSchema),
  fixedIn: z.string().optional(),
  references: z.array(z.string()),
});
export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

export const ItemVulnAssessmentSchema = z.object({
  item: UpdateItemSchema,
  affectingOld: z.array(VulnerabilitySchema),
  stillAffectingNew: z.array(VulnerabilitySchema),
  sources: z.array(z.string()),
  errors: z.array(z.string()),
});
export type ItemVulnAssessment = z.infer<typeof ItemVulnAssessmentSchema>;

export const PageProbeSchema = z.object({
  url: z.string(),
  status: z.number().int(),
  ttfbMs: z.number(),
  totalMs: z.number(),
  criticalError: z.boolean(),
  /** Local path of the normalised visible text. */
  textPath: z.string().optional(),
  screenshotPaths: z.partialRecord(z.enum(['desktop', 'mobile']), z.string()).optional(),
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(z.string()),
});
export type PageProbe = z.infer<typeof PageProbeSchema>;

export const HealthSnapshotSchema = z.object({
  snapshotId: z.string(),
  siteId: z.string(),
  label: z.string(),
  takenAt: z.string(),
  pages: z.array(PageProbeSchema),
  /** Log path → byte offset at snapshot time; later scans read only new bytes. */
  logOffsets: z.record(z.string(), z.number().int()),
});
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;

export const ThresholdsSchema = z.object({
  pixelDiffPct: z.number().default(2),
  slowdownFactor: z.number().default(1.5),
  slowdownMinMs: z.number().default(300),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const PageComparisonSchema = z.object({
  url: z.string(),
  statusBefore: z.number().int(),
  statusAfter: z.number().int(),
  statusChanged: z.boolean(),
  criticalError: z.boolean(),
  pixelDiffPct: z.partialRecord(z.enum(['desktop', 'mobile']), z.number()).optional(),
  diffImagePaths: z.partialRecord(z.enum(['desktop', 'mobile']), z.string()).optional(),
  textDiff: z.string().optional(),
  newConsoleErrors: z.array(z.string()),
  newFailedRequests: z.array(z.string()),
  slowdownMs: z.number(),
  problems: z.array(z.string()),
});
export type PageComparison = z.infer<typeof PageComparisonSchema>;

export const ComparisonResultSchema = z.object({
  ok: z.boolean(),
  pages: z.array(PageComparisonSchema),
  newLogErrors: z.array(z.string()),
});
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;

export const ItemOutcomeSchema = z.enum([
  'updated',
  'skipped',
  'held',
  'failed-rolled-back',
  'failed-rollback-failed',
  'dry-run',
]);
export type ItemOutcome = z.infer<typeof ItemOutcomeSchema>;

export const ItemResultSchema = z.object({
  item: UpdateItemSchema,
  outcome: ItemOutcomeSchema,
  /** Version actually installed afterwards (may differ from item.newVersion). */
  installedVersion: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  health: ComparisonResultSchema.optional(),
  error: z.string().optional(),
  /** Dry-run / audit: operations performed or that would be performed. */
  operations: z.array(z.string()).default([]),
});
export type ItemResult = z.infer<typeof ItemResultSchema>;

export const RunStatusSchema = z.enum(['pending', 'running', 'done', 'aborted', 'needs-restore', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z.object({
  runId: z.string(),
  siteId: z.string(),
  kind: z.enum(['backup', 'update', 'restore']),
  backupId: z.string().optional(),
  dryRun: z.boolean(),
  plan: z.array(UpdateItemSchema),
  results: z.array(ItemResultSchema),
  baseline: HealthSnapshotSchema.optional(),
  final: ComparisonResultSchema.optional(),
  status: RunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const ReportSchema = z.object({
  generatedAt: z.string(),
  site: z.object({ id: z.string(), name: z.string(), url: z.string() }),
  run: RunRecordSchema,
  backup: BackupManifestSchema.optional(),
  backupVerification: VerificationResultSchema.optional(),
  /** Section 1. */
  core: ItemVulnAssessmentSchema.optional(),
  /** Section 2. */
  themes: z.array(ItemVulnAssessmentSchema),
  /** Section 3 — only items whose outcome is `updated`. */
  plugins: z.array(ItemVulnAssessmentSchema),
  failed: z.array(ItemResultSchema),
  comparison: ComparisonResultSchema.optional(),
  attributions: z.array(z.string()),
});
export type Report = z.infer<typeof ReportSchema>;

import { z } from 'zod';
import { CapabilitiesSchema, FileStatSchema } from './connection.js';

/**
 * Agent action catalogue. The PHP agent (agent-php/) implements every action; the SSH transport runs them
 * via `php ~/.auto-wp/agent.php --cli <action>` (params as JSON on stdin), the agent transport via signed
 * HTTPS. See docs/agent-protocol.md for the wire format.
 */

const Slug = z.string().regex(/^[a-z0-9_.-]+$/i, 'invalid slug');
const RelPath = z.string().min(1).max(4096);
const Excludes = z.array(z.string()).default([]);

export const TableCountSchema = z.object({ name: z.string(), rows: z.number().int().nonnegative() });

export const WpUpdateInfoSchema = z.object({
  version: z.string(),
  requiresWp: z.string().optional(),
  requiresPhp: z.string().optional(),
  package: z.string().optional(),
});

export const WpPluginInfoSchema = z.object({
  slug: Slug,
  /** Plugin basename, e.g. `akismet/akismet.php`. */
  file: z.string(),
  name: z.string(),
  version: z.string(),
  active: z.boolean(),
  networkActive: z.boolean().default(false),
  /** `Update URI` header; `false` means updates disabled. */
  updateUri: z.string().optional(),
  /** `Requires Plugins` header slugs (WP 6.5+). */
  requiresPlugins: z.array(z.string()).default([]),
  update: WpUpdateInfoSchema.optional(),
});

export const WpThemeInfoSchema = z.object({
  slug: Slug,
  name: z.string(),
  version: z.string(),
  active: z.boolean(),
  parent: z.string().optional(),
  update: WpUpdateInfoSchema.optional(),
});

export const WpInventorySchema = z.object({
  core: z.object({
    version: z.string(),
    locale: z.string().default('en_US'),
    update: WpUpdateInfoSchema.optional(),
  }),
  plugins: z.array(WpPluginInfoSchema),
  themes: z.array(WpThemeInfoSchema),
  mustUse: z
    .array(z.object({ file: z.string(), name: z.string(), version: z.string().optional() }))
    .default([]),
  php: z.string(),
  db: z.string(),
});
export type WpInventory = z.infer<typeof WpInventorySchema>;

export const JobStatusSchema = z.object({
  jobId: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  progress: z.object({ done: z.number(), total: z.number().optional(), message: z.string().optional() }),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const actionSchemas = {
  probe: { params: z.object({}), result: CapabilitiesSchema },
  'job.status': { params: z.object({ jobId: z.string() }), result: JobStatusSchema },

  'fs.stat': { params: z.object({ path: RelPath }), result: FileStatSchema.nullable() },
  'fs.list': { params: z.object({ path: RelPath }), result: z.array(FileStatSchema) },
  'fs.readChunk': {
    params: z.object({
      path: RelPath,
      offset: z.number().int().nonnegative(),
      length: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
    }),
    result: z.object({ dataB64: z.string(), eof: z.boolean(), size: z.number().int() }),
  },
  'fs.writeChunk': {
    params: z.object({
      path: RelPath,
      offset: z.number().int().nonnegative(),
      dataB64: z.string(),
      truncate: z.boolean().default(false),
      mode: z.number().int().optional(),
    }),
    result: z.object({ bytesWritten: z.number().int() }),
  },
  'fs.mkdir': {
    params: z.object({
      path: RelPath,
      recursive: z.boolean().default(true),
      mode: z.number().int().optional(),
    }),
    result: z.object({}),
  },
  'fs.rename': { params: z.object({ from: RelPath, to: RelPath }), result: z.object({}) },
  'fs.remove': {
    params: z.object({ path: RelPath, recursive: z.boolean().default(false) }),
    result: z.object({}),
  },
  /** Create a .tar.gz of `sourceDir` at `dest`. Long-running (job). */
  'fs.archive': {
    params: z.object({
      sourceDir: RelPath,
      dest: RelPath,
      excludes: Excludes,
      paths: z.array(RelPath).optional(),
    }),
    result: z.object({
      fileCount: z.number().int(),
      bytes: z.number().int(),
      archiveBytes: z.number().int(),
      sha256: z.string(),
    }),
  },
  /** Extract a .tar.gz into `destDir`. Long-running (job). */
  'fs.extract': {
    params: z.object({ archive: RelPath, destDir: RelPath, overwrite: z.boolean().default(true) }),
    result: z.object({ fileCount: z.number().int() }),
  },
  'fs.count': {
    params: z.object({ dir: RelPath, excludes: Excludes }),
    result: z.object({ fileCount: z.number().int(), bytes: z.number().int() }),
  },
  'fs.sha256': {
    params: z.object({ path: RelPath }),
    result: z.object({ sha256: z.string(), bytes: z.number().int() }),
  },
  'fs.testArchive': {
    params: z.object({ path: RelPath }),
    result: z.object({ ok: z.boolean(), entries: z.number().int(), error: z.string().optional() }),
  },

  'db.info': {
    params: z.object({}),
    result: z.object({
      server: z.string(),
      version: z.string(),
      charset: z.string(),
      tables: z.array(TableCountSchema),
    }),
  },
  /** Gzipped SQL dump ending with `-- Dump completed <iso-ts>`. Long-running (job). */
  'db.dump': {
    params: z.object({ dest: RelPath, excludeTables: z.array(z.string()).default([]) }),
    result: z.object({
      tables: z.array(TableCountSchema),
      bytes: z.number().int(),
      sha256: z.string(),
      method: z.enum(['native', 'mysqldump']),
    }),
  },
  /** Import a (gzipped) SQL dump. Long-running (job). Destructive. */
  'db.import': { params: z.object({ source: RelPath }), result: z.object({ statements: z.number().int() }) },

  /** Bootstraps WordPress in an isolated request/process. Fails with code `wp_fatal` if WP is broken. */
  'wp.inventory': { params: z.object({ refresh: z.boolean().default(true) }), result: WpInventorySchema },
  'wp.upgrade': {
    params: z.object({
      type: z.enum(['core', 'plugin', 'theme']),
      slug: Slug,
      version: z.string().optional(),
    }),
    result: z.object({ fromVersion: z.string(), toVersion: z.string(), messages: z.array(z.string()) }),
  },
  'wp.maintenance': {
    params: z.object({ enabled: z.boolean(), bypassToken: z.string().min(16).optional() }),
    result: z.object({ enabled: z.boolean() }),
  },
  'logs.tail': {
    params: z.object({
      path: RelPath,
      fromOffset: z.number().int().nonnegative(),
      maxBytes: z
        .number()
        .int()
        .positive()
        .default(1024 * 1024),
    }),
    result: z.object({
      data: z.string(),
      nextOffset: z.number().int(),
      size: z.number().int(),
      rotated: z.boolean(),
    }),
  },
  'cache.flush': {
    params: z.object({ opcache: z.boolean().default(true), objectCache: z.boolean().default(true) }),
    result: z.object({ flushed: z.array(z.string()) }),
  },
  'lock.acquire': {
    params: z.object({ runId: z.string(), ttlSec: z.number().int().positive().default(3600) }),
    result: z.object({
      acquired: z.boolean(),
      holder: z.string().optional(),
      expiresAt: z.string().optional(),
    }),
  },
  'lock.release': { params: z.object({ runId: z.string() }), result: z.object({ released: z.boolean() }) },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type ActionName = keyof typeof actionSchemas;
export const ACTION_NAMES = Object.keys(actionSchemas) as ActionName[];
export type ActionParams = { [K in ActionName]: z.input<(typeof actionSchemas)[K]['params']> };
export type ActionResult = { [K in ActionName]: z.output<(typeof actionSchemas)[K]['result']> };

/** Actions that may answer with a job handle instead of a result (see protocol). */
export const LONG_RUNNING_ACTIONS: readonly ActionName[] = [
  'fs.archive',
  'fs.extract',
  'db.dump',
  'db.import',
  'fs.count',
  'fs.sha256',
];
/** Actions that need WordPress to bootstrap. All others must work with a broken WP. */
export const WP_BRIDGE_ACTIONS: readonly ActionName[] = ['wp.inventory', 'wp.upgrade'];

import { z } from 'zod';
import type { ActionName, ActionParams, ActionResult } from './actions.js';

export const TransportKindSchema = z.enum(['ssh', 'agent', 'sftp+agent']);
export type TransportKind = z.infer<typeof TransportKindSchema>;

export const BinaryNameSchema = z.enum(['tar', 'gzip', 'mysqldump', 'mysql', 'find', 'sha256sum']);
export type BinaryName = z.infer<typeof BinaryNameSchema>;

/** What the remote host can do. Returned by `probe()` and by the agent's `probe` action. */
export const CapabilitiesSchema = z.object({
  /** True when arbitrary (allowlisted) argv can be executed, i.e. SSH shell access. */
  shell: z.boolean(),
  /** True when PHP `exec`/`proc_open` are usable on the host (agent can shell out to tar/mysqldump). */
  execEnabled: z.boolean(),
  phpVersion: z.string(),
  phpCli: z.string().optional(),
  wpCli: z.object({ available: z.boolean(), path: z.string().optional(), version: z.string().optional() }),
  binaries: z.partialRecord(BinaryNameSchema, z.string()),
  sodium: z.boolean(),
  /** Absolute path of the web document root. */
  docroot: z.string(),
  /** Absolute path of the WordPress install (directory containing wp-config.php or wp-load.php). */
  wpRoot: z.string(),
  /** Writable directory above the docroot, if one exists (preferred backup location fallback). */
  outsideDocrootDir: z.string().optional(),
  diskFreeBytes: z.number().int().nonnegative().optional(),
  /** sha256 of the deployed agent.php, when an agent is involved. */
  agentSha256: z.string().optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const FileStatSchema = z.object({
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number().int().nonnegative(),
  mode: z.number().int(),
  mtimeMs: z.number(),
});
export type FileStat = z.infer<typeof FileStatSchema>;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Data written to the process' stdin. */
  stdin?: string | Buffer;
}

export interface Progress {
  done: number;
  total?: number;
  message?: string;
}

export interface CallOptions {
  onProgress?(p: Progress): void;
  timeoutMs?: number;
}

/**
 * A connection to one site. Implemented by transport-ssh and transport-agent.
 *
 * Paths: POSIX. Relative paths resolve against `Capabilities.wpRoot`. Every path (relative or absolute)
 * MUST resolve (after normalisation / realpath) inside wpRoot or `outsideDocrootDir`; transports reject
 * anything else with `PathJailError`.
 */
export interface SiteConnection {
  readonly siteId: string;
  readonly kind: TransportKind;
  probe(): Promise<Capabilities>;
  /** argv only — never a shell string. Throws `CapabilityError` when `shell` is false. */
  exec(argv: readonly string[], o?: ExecOptions): Promise<ExecResult>;
  /** Invoke an agent action. Long-running actions are polled transparently until done. */
  call<K extends ActionName>(action: K, params: ActionParams[K], o?: CallOptions): Promise<ActionResult[K]>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string, o?: { mode?: number; atomic?: boolean }): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
  list(path: string): Promise<FileStat[]>;
  mkdir(path: string, o?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, o?: { recursive?: boolean }): Promise<void>;
  download(path: string, o?: { offset?: number }): Promise<NodeJS.ReadableStream>;
  close(): Promise<void>;
}

export class CapabilityError extends Error {
  override name = 'CapabilityError';
}
export class PathJailError extends Error {
  override name = 'PathJailError';
}
export class AgentError extends Error {
  override name = 'AgentError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

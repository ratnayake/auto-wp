import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import {
  type ActionName,
  type ActionParams,
  type ActionResult,
  AgentError,
  actionSchemas,
  BinaryNameSchema,
  type CallOptions,
  type Capabilities,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  JobStatusSchema,
  type Logger,
  PathJailError,
  type SiteConnection,
  type SshTransportConfigSchema,
} from '@auto-wp/contracts';
import { Client } from 'ssh2';
import type { z } from 'zod';
import { defaultFetcher, type Fetcher, fetchWpCliPhar, sha256Hex } from './bootstrap.js';
import { ExecTimeoutError, HostKeyMismatchError, SshConnectError } from './errors.js';
import { cleanPath, isInside, PathJail } from './jail.js';
import { PROBE_SCRIPT, parseProbeOutput } from './probe-script.js';
import { buildCommand } from './quote.js';
import { Sftp, toFileStat } from './sftp.js';

export type SshTransportConfig = z.output<typeof SshTransportConfigSchema>;

export interface SshConnectionDeps {
  logger: Logger;
  /** Returns the bytes of the agent.php to deploy. */
  agentPhpSource: () => Promise<Buffer>;
  /** Defaults to `process.env.SSH_AUTH_SOCK`. */
  sshAgentSocket?: string;
  /** Fetches URLs on the controller (wp-cli.phar bootstrap). */
  fetcher?: Fetcher;
  createClient?: () => Client;
  sleep?: (ms: number) => Promise<void>;
  connectTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  /** Hard ceiling for one job (default 6 h). */
  jobMaxMs?: number;
  /** A running job whose progress does not change for this long is treated as stuck (default 10 min). */
  jobStallMs?: number;
  now?: () => number;
}

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const POLL_INITIAL_MS = 250;
const POLL_MAX_MS = 2_000;
const DEFAULT_JOB_MAX_MS = 6 * 3600_000;
const DEFAULT_JOB_STALL_MS = 10 * 60_000;
const BACKUP_DIR = 'auto-wp-backup';
const PID_MARKER = 'AUTOWP_PID=';

export const fingerprintOf = (hostKey: Buffer): string =>
  `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;

export class SshSiteConnection implements SiteConnection {
  readonly kind = 'ssh' as const;
  private clientP?: Promise<Client>;
  private activeClient?: Client;
  private outsideDir?: string;
  private sftpP?: Promise<Sftp>;
  private toolsP?: Promise<{ toolDir: string; agentPath: string }>;
  private caps?: Capabilities;
  private agentSha?: string;
  private readonly jail: PathJail;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly siteId: string,
    private readonly config: SshTransportConfig,
    private readonly deps: SshConnectionDeps,
  ) {
    if (!config.wpRoot.startsWith('/')) throw new Error('wpRoot must be an absolute path');
    if (!(config.toolDir === '~' || config.toolDir.startsWith('~/') || config.toolDir.startsWith('/'))) {
      throw new Error('toolDir must be absolute or start with ~/');
    }
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jail = new PathJail({
      wpRoot: config.wpRoot,
      outsideDocrootDir: () => this.outsideDir,
      realpath: async (p) => (await this.sftp()).realpathOrNull(p),
    });
  }

  // ---- connection -------------------------------------------------------------------------------

  /** Connects (idempotent). Called lazily by every operation. */
  connect(): Promise<void> {
    return this.client().then(() => undefined);
  }

  private client(): Promise<Client> {
    this.clientP ??= this.openClient().catch((e) => {
      this.clientP = undefined;
      throw e;
    });
    return this.clientP;
  }

  private openClient(): Promise<Client> {
    const { host, port, username, hostKeySha256 } = this.config;
    const agent = this.deps.sshAgentSocket ?? process.env.SSH_AUTH_SOCK;
    if (!agent) {
      return Promise.reject(new SshConnectError('ssh-agent is required but SSH_AUTH_SOCK is not set'));
    }
    const expected = hostKeySha256.replace(/=+$/, '');
    const client = this.deps.createClient?.() ?? new Client();
    this.activeClient = client;
    return new Promise<Client>((resolve, reject) => {
      let settled = false;
      let mismatch: Error | undefined;
      const fail = (e: Error) => {
        if (!settled) {
          settled = true;
          reject(mismatch ?? e);
        }
      };
      client.on('error', (e: Error) => {
        this.deps.logger.warn({ siteId: this.siteId, err: e.message }, 'ssh connection error');
        fail(e);
      });
      client.on('close', () => {
        fail(new SshConnectError('connection closed before it was ready'));
        if (this.activeClient === client) {
          this.activeClient = undefined;
          this.clientP = undefined;
          this.sftpP = undefined;
          this.toolsP = undefined;
        }
      });
      client.on('ready', () => {
        settled = true;
        resolve(client);
      });
      client.connect({
        host,
        port,
        username,
        agent,
        readyTimeout: this.deps.connectTimeoutMs ?? 20_000,
        keepaliveInterval: this.deps.keepaliveIntervalMs ?? 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const actual = fingerprintOf(key);
          if (actual === expected) return true;
          mismatch = new HostKeyMismatchError(host, hostKeySha256, actual);
          this.deps.logger.error({ siteId: this.siteId, host, expected, actual }, 'ssh host key mismatch');
          return false;
        },
      });
    });
  }

  private sftp(): Promise<Sftp> {
    const sp: Promise<Sftp> = (this.sftpP ??= this.client()
      .then(
        (c) =>
          new Promise<Sftp>((resolve, reject) => {
            c.sftp((err, s) => {
              if (err) return reject(err);
              const w = new Sftp(s);
              w.onClose((e) => {
                if (e) this.deps.logger.warn({ siteId: this.siteId, err: e.message }, 'sftp channel error');
                if (this.sftpP === sp) this.sftpP = undefined;
              });
              resolve(w);
            });
          }),
      )
      .catch((e) => {
        this.sftpP = undefined;
        throw e;
      }));
    return sp;
  }

  async close(): Promise<void> {
    const clientP = this.clientP;
    const sftpP = this.sftpP;
    this.clientP = this.sftpP = this.toolsP = this.activeClient = undefined;
    if (sftpP) (await sftpP.catch(() => undefined))?.end();
    if (clientP) (await clientP.catch(() => undefined))?.end();
  }

  // ---- exec -------------------------------------------------------------------------------------

  /** Runs in `wpRoot` unless `cwd` is given (jailed). */
  async exec(argv: readonly string[], o: ExecOptions = {}): Promise<ExecResult> {
    const cwd = (await this.jail.resolve(o.cwd ?? this.config.wpRoot)).real;
    const command = buildCommand(argv, { cwd, env: o.env });
    return this.run(command, o.stdin, o.timeoutMs);
  }

  /**
   * With a timeout, the command is prefixed with `echo AUTOWP_PID=$$ >&2`: the remote shell's pid, which the
   * final `exec` keeps, so a timeout can kill the real process instead of only closing the channel.
   */
  private async run(command: string, stdin?: string | Buffer, timeoutMs?: number): Promise<ExecResult> {
    const client = await this.client();
    const started = Date.now();
    const withTimeout = timeoutMs !== undefined && timeoutMs > 0;
    const full = withTimeout ? `echo "${PID_MARKER}$$" >&2; ${command}` : command;
    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(full, (err, stream) => {
        if (err) return reject(err);
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;
        const stderrText = () => {
          const t = Buffer.concat(errOut).toString('utf8');
          const m = withTimeout ? t.match(/^AUTOWP_PID=(\d+)\n/) : null;
          return { pid: m?.[1], text: m ? t.slice(m[0].length) : t };
        };
        if (withTimeout) {
          timer = setTimeout(async () => {
            timedOut = true;
            const { pid } = stderrText();
            (stream as { signal?: (n: string) => void }).signal?.('KILL');
            if (pid) {
              await this.run(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`).catch(
                (e) => this.deps.logger.warn({ siteId: this.siteId, err: String(e) }, 'remote kill failed'),
              );
            }
            stream.close();
            reject(new ExecTimeoutError(timeoutMs));
          }, timeoutMs);
        }
        stream.on('data', (d: Buffer) => out.push(d));
        stream.stderr.on('data', (d: Buffer) => errOut.push(d));
        stream.on('error', (e: Error) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });
        stream.on('close', (code: number | null) => {
          if (timer) clearTimeout(timer);
          if (timedOut) return;
          resolve({
            exitCode: code ?? -1,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: stderrText().text,
            durationMs: Date.now() - started,
          });
        });
        if (stdin !== undefined) stream.end(stdin);
        else stream.end();
      });
    });
  }

  // ---- tool bootstrap ---------------------------------------------------------------------------

  private ensureTools(): Promise<{ toolDir: string; agentPath: string }> {
    this.toolsP ??= this.bootstrapTools().catch((e) => {
      this.toolsP = undefined;
      throw e;
    });
    return this.toolsP;
  }

  private async bootstrapTools(): Promise<{ toolDir: string; agentPath: string }> {
    const sftp = await this.sftp();
    const home = await sftp.realpath('.');
    const t = this.config.toolDir;
    const toolDir = t === '~' ? home : t.startsWith('~/') ? posix.join(home, t.slice(2)) : t;
    await this.mkdirp(sftp, toolDir, 0o700);
    await sftp.chmod(toolDir, 0o700);

    const agentPath = posix.join(toolDir, 'agent.php');
    const source = await this.deps.agentPhpSource();
    const wantSha = sha256Hex(source);
    const current = await sftp.lstat(agentPath).then((a) => (a ? sftp.readFile(agentPath) : null));
    if (!current || sha256Hex(current) !== wantSha) {
      this.deps.logger.info({ siteId: this.siteId, sha256: wantSha }, 'uploading agent.php');
      await this.writeAtomic(sftp, agentPath, source, 0o600);
    }
    this.agentSha = wantSha;
    return { toolDir, agentPath };
  }

  private async installWpCli(toolDir: string): Promise<void> {
    const phar = await fetchWpCliPhar(this.deps.fetcher ?? defaultFetcher);
    await this.writeAtomic(await this.sftp(), posix.join(toolDir, 'wp-cli.phar'), phar, 0o700);
    this.deps.logger.info({ siteId: this.siteId }, 'installed wp-cli.phar');
  }

  // ---- probe ------------------------------------------------------------------------------------

  async probe(): Promise<Capabilities> {
    const { toolDir } = await this.ensureTools();
    const runScript = async () => {
      const r = await this.run(
        buildCommand(['sh', '-c', PROBE_SCRIPT, 'sh', this.config.phpBinary, toolDir, this.config.wpRoot]),
        undefined,
        60_000,
      );
      return parseProbeOutput(r.stdout);
    };
    let s = await runScript();
    if (!s.wpPath && s.phpBin) {
      try {
        await this.installWpCli(toolDir);
        s = await runScript();
      } catch (e) {
        this.deps.logger.warn({ siteId: this.siteId, err: String(e) }, 'wp-cli bootstrap failed');
      }
    }

    let agent: ActionResult['probe'] | undefined;
    if (s.phpBin) {
      try {
        agent = await this.call('probe', {});
      } catch (e) {
        this.deps.logger.warn({ siteId: this.siteId, err: String(e) }, 'agent probe failed');
      }
    }

    const binaries: Capabilities['binaries'] = { ...agent?.binaries };
    for (const [k, v] of Object.entries(s.binaries)) {
      const name = BinaryNameSchema.safeParse(k);
      if (name.success) binaries[name.data] = v;
    }
    const caps: Capabilities = {
      shell: true,
      execEnabled: agent?.execEnabled ?? false,
      phpVersion: s.phpVersion ?? agent?.phpVersion ?? 'unknown',
      phpCli: s.phpBin ?? agent?.phpCli,
      wpCli: s.wpPath ? { available: true, path: s.wpPath, version: s.wpVersion } : { available: false },
      binaries,
      sodium: s.sodium || (agent?.sodium ?? false),
      docroot: agent?.docroot ?? s.docroot ?? this.config.wpRoot,
      wpRoot: this.config.wpRoot,
      outsideDocrootDir: await this.chooseOutsideDir(agent?.outsideDocrootDir, s.outsideParent),
      diskFreeBytes: s.diskFreeBytes ?? agent?.diskFreeBytes,
      agentSha256: this.agentSha,
    };
    this.caps = caps;
    this.outsideDir = caps.outsideDocrootDir;
    return caps;
  }

  /**
   * The off-docroot jail root must be a dedicated directory: never `/`, the home dir, an ancestor of wpRoot
   * or toolDir, or a directory holding `.ssh`. Without an agent-supplied dir, `<parent of wpRoot>/auto-wp-backup`
   * is created (0700) when the parent is writable.
   */
  private async chooseOutsideDir(fromAgent?: string, parent?: string): Promise<string | undefined> {
    const sftp = await this.sftp();
    const home = await sftp.realpath('.');
    const { toolDir } = await this.ensureTools();
    const acceptable = async (dir: string): Promise<boolean> => {
      if (!dir.startsWith('/')) return false;
      const d = cleanPath(dir);
      if (d === '/' || d === home || isInside(this.config.wpRoot, d) || isInside(toolDir, d)) return false;
      if (isInside(d, toolDir) || isInside(d, cleanPath(this.config.wpRoot))) return false;
      return (await sftp.lstat(posix.join(d, '.ssh'))) === null;
    };
    if (fromAgent && (await acceptable(fromAgent))) return cleanPath(fromAgent);
    if (fromAgent)
      this.deps.logger.warn({ siteId: this.siteId, dir: fromAgent }, 'ignoring unsafe outsideDocrootDir');
    if (!parent) return undefined;
    const dir = posix.join(cleanPath(parent), BACKUP_DIR);
    if (!(await acceptable(dir))) return undefined;
    try {
      await this.mkdirp(sftp, dir, 0o700);
      await sftp.chmod(dir, 0o700);
      return dir;
    } catch (e) {
      this.deps.logger.warn({ siteId: this.siteId, err: String(e) }, 'cannot create off-docroot backup dir');
      return undefined;
    }
  }

  // ---- agent calls ------------------------------------------------------------------------------

  async call<K extends ActionName>(
    action: K,
    params: ActionParams[K],
    o: CallOptions = {},
  ): Promise<ActionResult[K]> {
    const now = this.deps.now ?? Date.now;
    const body = await this.invoke(action, params, o.timeoutMs);
    if (!('job' in body)) return this.parseResult(action, body.result);

    const { jobId } = body.job;
    const startedAt = now();
    const deadline = startedAt + (o.timeoutMs ?? this.deps.jobMaxMs ?? DEFAULT_JOB_MAX_MS);
    const stallMs = this.deps.jobStallMs ?? DEFAULT_JOB_STALL_MS;
    let lastProgress = '';
    let lastChange = startedAt;
    let delay = POLL_INITIAL_MS;
    for (;;) {
      if (now() > deadline) throw new AgentError('internal', `job ${jobId} did not finish in time`);
      await this.sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
      const remaining = Math.max(1, deadline - now());
      const st = await this.callDirect('job.status', { jobId }, Math.min(remaining, DEFAULT_EXEC_TIMEOUT_MS));
      o.onProgress?.(st.progress);
      if (st.state === 'failed') {
        throw new AgentError(st.error?.code ?? 'internal', st.error?.message ?? `job ${jobId} failed`);
      }
      if (st.state === 'done') return this.parseResult(action, st.result);
      const sig = JSON.stringify(st.progress);
      if (sig !== lastProgress) {
        lastProgress = sig;
        lastChange = now();
      } else if (now() - lastChange > stallMs) {
        throw new AgentError('internal', `job ${jobId} made no progress for ${Math.round(stallMs / 1000)}s`);
      }
    }
  }

  private async callDirect<K extends ActionName>(
    action: K,
    params: ActionParams[K],
    timeoutMs?: number,
  ): Promise<ActionResult[K]> {
    const body = await this.invoke(action, params, timeoutMs);
    if ('job' in body) throw new AgentError('internal', `${action} unexpectedly returned a job`);
    return this.parseResult(action, body.result);
  }

  private parseResult<K extends ActionName>(action: K, result: unknown): ActionResult[K] {
    const r = actionSchemas[action].result.safeParse(result);
    if (!r.success) throw new AgentError('internal', `invalid ${action} result: ${r.error.message}`);
    return r.data as ActionResult[K];
  }

  private async invoke(
    action: ActionName,
    params: unknown,
    timeoutMs?: number,
  ): Promise<{ result: unknown } | { job: { jobId: string } }> {
    const p = actionSchemas[action].params.safeParse(params);
    if (!p.success) throw new AgentError('invalid_params', `invalid ${action} params: ${p.error.message}`);
    const { agentPath } = await this.ensureTools();
    // The agent has no config of its own over SSH: tell it which WordPress root to work on.
    const argv = [this.config.phpBinary, agentPath, '--cli', action, '--wp-root', this.config.wpRoot];
    const r = await this.exec(argv, {
      stdin: JSON.stringify(p.data),
      timeoutMs: timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    });
    let json: unknown;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      throw new AgentError(
        'internal',
        `agent produced no valid JSON (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 500)}`,
      );
    }
    const body = json as {
      ok?: unknown;
      error?: { code?: unknown; message?: unknown };
      result?: unknown;
      job?: { jobId?: unknown };
    };
    if (body?.ok === false) {
      throw new AgentError(
        String(body.error?.code ?? 'internal'),
        String(body.error?.message ?? 'agent error'),
      );
    }
    if (body?.ok !== true) throw new AgentError('internal', 'malformed agent response');
    if (body.job && typeof body.job.jobId === 'string') return { job: { jobId: body.job.jobId } };
    return { result: body.result };
  }

  // ---- files ------------------------------------------------------------------------------------

  async readFile(path: string): Promise<Buffer> {
    const { real } = await this.jail.resolve(path);
    return (await this.sftp()).readFile(real);
  }

  async writeFile(
    path: string,
    data: Buffer | string,
    o: { mode?: number; atomic?: boolean } = {},
  ): Promise<void> {
    const { real } = await this.jail.resolve(path);
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const sftp = await this.sftp();
    if (o.atomic === false) {
      const cur = await sftp.lstat(real);
      if (cur && (cur.mode & 0o170000) === 0o120000) {
        throw new PathJailError(`refusing non-atomic write through a symlink: ${path}`);
      }
      await sftp.writeFile(real, buf, o.mode);
      if (o.mode !== undefined) await sftp.chmod(real, o.mode);
    } else {
      await this.writeAtomic(sftp, real, buf, o.mode);
    }
  }

  private async writeAtomic(sftp: Sftp, real: string, data: Buffer, mode?: number): Promise<void> {
    const tmp = `${real}.auto-wp-tmp-${randomBytes(6).toString('hex')}`;
    try {
      // Keep the existing file's permissions (e.g. a 0600 wp-config.php) unless a mode is requested.
      const existing = mode === undefined ? await sftp.lstat(real) : null;
      const finalMode =
        mode ?? (existing && (existing.mode & 0o170000) === 0o100000 ? existing.mode & 0o7777 : undefined);
      await sftp.writeFile(tmp, data, finalMode);
      if (finalMode !== undefined) await sftp.chmod(tmp, finalMode);
      await sftp.rename(tmp, real);
    } catch (e) {
      await sftp.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    const { lexical, real } = await this.jail.resolve(path, false);
    const a = await (await this.sftp()).lstat(real);
    return a ? toFileStat(lexical, a) : null;
  }

  async list(path: string): Promise<FileStat[]> {
    const { lexical, real } = await this.jail.resolve(path);
    const entries = await (await this.sftp()).readdir(real);
    return entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => toFileStat(posix.join(lexical, e.filename), e.attrs));
  }

  async mkdir(path: string, o: { recursive?: boolean; mode?: number } = {}): Promise<void> {
    const { real } = await this.jail.resolve(path);
    const sftp = await this.sftp();
    if (o.recursive) await this.mkdirp(sftp, real, o.mode);
    else await sftp.mkdir(real, o.mode);
  }

  private async mkdirp(sftp: Sftp, dir: string, mode?: number): Promise<void> {
    if (await sftp.stat(dir)) return;
    const parent = posix.dirname(dir);
    if (parent !== dir) await this.mkdirp(sftp, parent, mode);
    try {
      await sftp.mkdir(dir, mode);
    } catch (e) {
      if (!(await sftp.stat(dir))) throw e; // lost a race with another creator
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const a = await this.jail.resolve(from, false);
    const b = await this.jail.resolve(to, false);
    await (await this.sftp()).rename(a.real, b.real);
  }

  async remove(path: string, o: { recursive?: boolean } = {}): Promise<void> {
    const { lexical, real } = await this.jail.resolve(path, false);
    if ((await this.jail.isRootOrAncestor(lexical)) || (await this.jail.isRootOrAncestor(real))) {
      throw new PathJailError(`refusing to remove a jail root or one of its ancestors: ${path}`);
    }
    await this.removeReal(await this.sftp(), real, o.recursive ?? false);
  }

  private async removeReal(sftp: Sftp, real: string, recursive: boolean): Promise<void> {
    const a = await sftp.lstat(real);
    if (!a) return;
    if (toFileStat(real, a).type !== 'dir') return sftp.unlink(real);
    if (recursive) {
      for (const e of await sftp.readdir(real)) {
        if (e.filename === '.' || e.filename === '..') continue;
        await this.removeReal(sftp, posix.join(real, e.filename), true);
      }
    }
    await sftp.rmdir(real);
  }

  async download(path: string, o: { offset?: number } = {}): Promise<NodeJS.ReadableStream> {
    const { real } = await this.jail.resolve(path);
    return (await this.sftp()).createReadStream(real, o.offset ?? 0);
  }
}

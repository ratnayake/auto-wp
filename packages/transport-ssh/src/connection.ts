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
import { PathJail } from './jail.js';
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
}

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const POLL_INITIAL_MS = 250;
const POLL_MAX_MS = 2_000;

export const fingerprintOf = (hostKey: Buffer): string =>
  `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;

export class SshSiteConnection implements SiteConnection {
  readonly kind = 'ssh' as const;
  private clientP?: Promise<Client>;
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
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jail = new PathJail({
      wpRoot: config.wpRoot,
      outsideDocrootDir: () => this.caps?.outsideDocrootDir,
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
        if (this.clientP) {
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
    this.sftpP ??= this.client()
      .then(
        (c) =>
          new Promise<Sftp>((resolve, reject) => {
            c.sftp((err, s) => (err ? reject(err) : resolve(new Sftp(s))));
          }),
      )
      .catch((e) => {
        this.sftpP = undefined;
        throw e;
      });
    return this.sftpP;
  }

  async close(): Promise<void> {
    const clientP = this.clientP;
    const sftpP = this.sftpP;
    this.clientP = this.sftpP = this.toolsP = undefined;
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

  private async run(command: string, stdin?: string | Buffer, timeoutMs?: number): Promise<ExecResult> {
    const client = await this.client();
    const started = Date.now();
    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
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
            stderr: Buffer.concat(errOut).toString('utf8'),
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
      outsideDocrootDir: agent?.outsideDocrootDir ?? s.outsideDocrootDir,
      diskFreeBytes: s.diskFreeBytes ?? agent?.diskFreeBytes,
      agentSha256: this.agentSha,
    };
    this.caps = caps;
    return caps;
  }

  // ---- agent calls ------------------------------------------------------------------------------

  async call<K extends ActionName>(
    action: K,
    params: ActionParams[K],
    o: CallOptions = {},
  ): Promise<ActionResult[K]> {
    const deadline = o.timeoutMs ? Date.now() + o.timeoutMs : Number.POSITIVE_INFINITY;
    const body = await this.invoke(action, params, o.timeoutMs);
    if (!('job' in body)) return this.parseResult(action, body.result);

    const { jobId } = body.job;
    let delay = POLL_INITIAL_MS;
    for (;;) {
      if (Date.now() > deadline) throw new AgentError('internal', `job ${jobId} did not finish in time`);
      await this.sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
      const st = await this.callDirect('job.status', { jobId }, o.timeoutMs);
      o.onProgress?.(st.progress);
      if (st.state === 'failed') {
        throw new AgentError(st.error?.code ?? 'internal', st.error?.message ?? `job ${jobId} failed`);
      }
      if (st.state === 'done') return this.parseResult(action, st.result);
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
    const r = await this.exec([this.config.phpBinary, agentPath, '--cli', action], {
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
      await sftp.writeFile(real, buf, o.mode);
      if (o.mode !== undefined) await sftp.chmod(real, o.mode);
    } else {
      await this.writeAtomic(sftp, real, buf, o.mode);
    }
  }

  private async writeAtomic(sftp: Sftp, real: string, data: Buffer, mode?: number): Promise<void> {
    const tmp = `${real}.auto-wp-tmp-${randomBytes(6).toString('hex')}`;
    try {
      await sftp.writeFile(tmp, data, mode);
      if (mode !== undefined) await sftp.chmod(tmp, mode);
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
    if (lexical === posix.normalize(this.config.wpRoot) || real === '/') {
      throw new PathJailError('refusing to remove the WordPress root');
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

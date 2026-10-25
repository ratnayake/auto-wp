import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  type ActionName,
  type ActionParams,
  type ActionResult,
  AgentError,
  type AgentResponseBody,
  type AgentTransportConfigSchema,
  actionSchemas,
  type CallOptions,
  type Capabilities,
  CapabilityError,
  type Clock,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type Logger,
  PathJailError,
  type SecretStore,
  type SiteConnection,
} from '@auto-wp/contracts';
import { assertSecureEndpoint, TransportSecurityError } from './security.js';
import { createSigner, type Signer, signedHeaders } from './signing.js';

export type AgentTransportConfig = ReturnType<typeof AgentTransportConfigSchema.parse>;

export const IDEMPOTENT_ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>([
  'probe',
  'job.status',
  'fs.stat',
  'fs.list',
  'fs.readChunk',
  'fs.count',
  'fs.sha256',
  'fs.testArchive',
  'db.info',
  'wp.inventory',
  'logs.tail',
]);

export const DOWNLOAD_CHUNK = 4 * 1024 * 1024;
export const UPLOAD_CHUNK = 2 * 1024 * 1024;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AgentConnectionDeps {
  siteId: string;
  config: AgentTransportConfig;
  secrets: SecretStore;
  logger: Logger;
  clock?: Clock;
  fetch?: FetchLike;
  nonce?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout. Default 60 s (the agent time-boxes each slice to ~20 s). */
  requestTimeoutMs?: number;
  /** Attempts for idempotent actions (default 3). */
  maxAttempts?: number;
  /** Upper bound for a job to complete (default 2 h). */
  maxJobMs?: number;
}

class RetryableError extends Error {
  override name = 'RetryableError';
}

const defaultNonce = () => randomBytes(16).toString('base64url');
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function checkPath(p: string): void {
  if (p.includes('\0') || p.split('/').includes('..'))
    throw new PathJailError(`path escapes site root: ${p}`);
}

export class AgentSiteConnection implements SiteConnection {
  readonly kind = 'agent' as const;
  readonly siteId: string;
  private readonly endpoint: URL;
  private readonly clock: Clock;
  private readonly fetchFn: FetchLike;
  private readonly nonce: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxJobMs: number;
  private signer?: Promise<Signer>;

  constructor(private readonly d: AgentConnectionDeps) {
    this.siteId = d.siteId;
    this.endpoint = assertSecureEndpoint(d.config.endpoint, d.config.insecureHttpLoopback);
    this.clock = d.clock ?? { now: () => new Date() };
    this.fetchFn = d.fetch ?? ((u, i) => fetch(u, i));
    this.nonce = d.nonce ?? defaultNonce;
    this.sleep = d.sleep ?? defaultSleep;
    this.timeoutMs = d.requestTimeoutMs ?? 60_000;
    this.maxAttempts = d.maxAttempts ?? 3;
    this.maxJobMs = d.maxJobMs ?? 2 * 3600_000;
  }

  private getSigner(): Promise<Signer> {
    this.signer ??= this.d.secrets
      .get(this.d.config.signingKeyRef)
      .then((s) => createSigner(this.d.config.algorithm, s));
    // Do not cache failures.
    this.signer.catch(() => {
      this.signer = undefined;
    });
    return this.signer;
  }

  async probe(): Promise<Capabilities> {
    const caps = await this.call('probe', {});
    const expected = this.d.config.agentSha256;
    if (expected && caps.agentSha256?.toLowerCase() !== expected.toLowerCase()) {
      this.d.logger.error(
        { siteId: this.siteId, expected, reported: caps.agentSha256 },
        'agent sha256 mismatch',
      );
      throw new TransportSecurityError(
        'agent.php sha256 does not match the pinned value; tampering suspected, refusing connection',
      );
    }
    return caps;
  }

  async exec(_argv: readonly string[], _o?: ExecOptions): Promise<ExecResult> {
    throw new CapabilityError('the agent transport cannot execute commands (shell unavailable)');
  }

  /** One signed POST. Always uses a fresh nonce and timestamp. */
  private async post(body: string, timeoutMs: number): Promise<AgentResponseBody | null> {
    const signer = await this.getSigner();
    const headers = signedHeaders(signer, this.d.config.keyId, {
      method: 'POST',
      path: this.endpoint.pathname,
      timestamp: Math.floor(this.clock.now().getTime() / 1000),
      nonce: this.nonce(),
      siteId: this.siteId,
      body,
    });
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint.toString(), {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RetryableError(`agent request failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
    const text = await res.text().catch(() => '');
    if (res.status >= 300 && res.status < 400) {
      throw new TransportSecurityError(
        `agent endpoint answered with a redirect (HTTP ${res.status}); redirects are refused`,
      );
    }
    if (res.status === 404) {
      throw new AgentError(
        'unreachable_or_rejected',
        'agent unreachable or auth rejected (HTTP 404): check endpoint URL, key, site id and clock skew',
      );
    }
    let parsed: AgentResponseBody | null = null;
    try {
      const j = JSON.parse(text) as unknown;
      if (j && typeof j === 'object' && 'ok' in j) parsed = j as AgentResponseBody;
    } catch {
      // not JSON
    }
    if (res.status >= 500) {
      throw Object.assign(new RetryableError(`agent returned HTTP ${res.status}`), { body: parsed });
    }
    if (!parsed)
      throw new AgentError('bad_response', `agent returned a non-protocol response (HTTP ${res.status})`);
    return parsed;
  }

  private async send(action: ActionName, body: string, timeoutMs: number): Promise<AgentResponseBody> {
    const attempts = IDEMPOTENT_ACTIONS.has(action) ? this.maxAttempts : 1;
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const r = await this.post(body, timeoutMs);
        if (r) return r;
      } catch (e) {
        if (!(e instanceof RetryableError)) throw e;
        lastErr = e;
        this.d.logger.warn(
          { siteId: this.siteId, action, attempt: i, err: e.message },
          'agent request failed',
        );
        if (i < attempts) await this.sleep(200 * 2 ** (i - 1));
      }
    }
    const withBody = lastErr as { body?: AgentResponseBody | null };
    if (withBody.body && !withBody.body.ok)
      throw new AgentError(withBody.body.error.code, withBody.body.error.message);
    throw new AgentError('transport', (lastErr as Error).message);
  }

  async call<K extends ActionName>(
    action: K,
    params: ActionParams[K],
    o: CallOptions = {},
  ): Promise<ActionResult[K]> {
    const schema = actionSchemas[action];
    if (!schema) throw new AgentError('unknown_action', `unknown action ${String(action)}`);
    const parsedParams = schema.params.parse(params);
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    let res = await this.send(action, JSON.stringify({ action, params: parsedParams }), timeoutMs);

    if (res.ok && 'job' in res) {
      res = await this.pollJob(res.job.jobId, timeoutMs, o);
    }
    if (!res.ok) throw new AgentError(res.error.code, res.error.message);
    if (!('result' in res)) throw new AgentError('bad_response', 'agent response has neither result nor job');
    const valid = schema.result.safeParse(res.result);
    if (!valid.success) {
      throw new AgentError('bad_response', `invalid ${action} result from agent: ${valid.error.message}`);
    }
    return valid.data as ActionResult[K];
  }

  private async pollJob(jobId: string, timeoutMs: number, o: CallOptions): Promise<AgentResponseBody> {
    const started = Date.now();
    let delay = 250;
    for (;;) {
      const r = await this.call('job.status', { jobId }, { timeoutMs });
      o.onProgress?.(r.progress);
      if (r.state === 'done') return { ok: true, result: r.result };
      if (r.state === 'failed') {
        return { ok: false, error: r.error ?? { code: 'internal', message: 'job failed' } };
      }
      if (Date.now() - started > this.maxJobMs)
        throw new AgentError('timeout', `job ${jobId} did not finish in time`);
      await this.sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 2000);
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of this.chunks(path, 0)) parts.push(c);
    return Buffer.concat(parts);
  }

  private async *chunks(path: string, offset: number): AsyncGenerator<Buffer> {
    checkPath(path);
    let pos = offset;
    for (;;) {
      const r = await this.call('fs.readChunk', { path, offset: pos, length: DOWNLOAD_CHUNK });
      const buf = Buffer.from(r.dataB64, 'base64');
      if (buf.length > 0) yield buf;
      pos += buf.length;
      if (r.eof) {
        if (pos !== r.size)
          throw new AgentError('bad_response', `short read of ${path}: got ${pos} of ${r.size} bytes`);
        return;
      }
      if (buf.length === 0)
        throw new AgentError('bad_response', `agent returned an empty non-final chunk for ${path}`);
    }
  }

  async download(path: string, o?: { offset?: number }): Promise<NodeJS.ReadableStream> {
    checkPath(path);
    return Readable.from(this.chunks(path, o?.offset ?? 0), { objectMode: false });
  }

  async writeFile(
    path: string,
    data: Buffer | string,
    o?: { mode?: number; atomic?: boolean },
  ): Promise<void> {
    checkPath(path);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const atomic = o?.atomic ?? true;
    const target = atomic ? `${path}.tmp-${randomBytes(6).toString('hex')}` : path;
    try {
      let offset = 0;
      do {
        const part = buf.subarray(offset, offset + UPLOAD_CHUNK);
        const r = await this.call('fs.writeChunk', {
          path: target,
          offset,
          dataB64: part.toString('base64'),
          truncate: offset === 0,
          ...(o?.mode !== undefined ? { mode: o.mode } : {}),
        });
        if (r.bytesWritten !== part.length) {
          throw new AgentError(
            'bad_response',
            `short write to ${path}: ${r.bytesWritten} of ${part.length} bytes`,
          );
        }
        offset += part.length;
      } while (offset < buf.length);

      const want = createHash('sha256').update(buf).digest('hex');
      const got = await this.call('fs.sha256', { path: target });
      if (got.sha256.toLowerCase() !== want || got.bytes !== buf.length) {
        throw new AgentError('integrity', `upload of ${path} failed verification (sha256 mismatch)`);
      }
      if (atomic) await this.call('fs.rename', { from: target, to: path });
    } catch (e) {
      if (atomic) await this.call('fs.remove', { path: target }).catch(() => undefined);
      throw e;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    checkPath(path);
    return this.call('fs.stat', { path });
  }

  async list(path: string): Promise<FileStat[]> {
    checkPath(path);
    return this.call('fs.list', { path });
  }

  async mkdir(path: string, o?: { recursive?: boolean; mode?: number }): Promise<void> {
    checkPath(path);
    await this.call('fs.mkdir', {
      path,
      ...(o?.recursive !== undefined ? { recursive: o.recursive } : {}),
      ...(o?.mode !== undefined ? { mode: o.mode } : {}),
    });
  }

  async rename(from: string, to: string): Promise<void> {
    checkPath(from);
    checkPath(to);
    await this.call('fs.rename', { from, to });
  }

  async remove(path: string, o?: { recursive?: boolean }): Promise<void> {
    checkPath(path);
    await this.call('fs.remove', { path, recursive: o?.recursive ?? false });
  }

  async close(): Promise<void> {}
}

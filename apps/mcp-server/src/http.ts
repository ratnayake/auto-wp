import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { type Authenticator, isLoopbackHost, type Principal, RateLimiter } from './auth.js';
import type { Services } from './container.js';
import { RunManager } from './runs.js';
import { buildServerWithRuns } from './server.js';

export * from './auth.js';

export interface HttpServerOptions {
  services: Services;
  authenticator: Authenticator;
  host?: string;
  port?: number;
  /** Required to bind a non-loopback address (intended: behind a TLS reverse proxy such as Caddy). */
  allowRemote?: boolean;
  /** Extra Host header names accepted (the public hostname when behind a proxy). Loopback is always allowed. */
  allowedHosts?: string[];
  /** Origins accepted when a browser sends an Origin header. Loopback origins are always allowed. */
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  /** Requests per minute per authenticated principal. */
  rateLimitPerMinute?: number;
  maxSessions?: number;
  sessionIdleMs?: number;
  endpoint?: string;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  principal: string;
  lastSeen: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const hostnameOf = (hostHeader: string): string => {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? h;
};

export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && !opts.allowRemote) {
    throw new Error(
      `refusing to bind non-loopback address ${host} without --allow-remote (put the server behind a TLS proxy)`,
    );
  }
  const endpoint = opts.endpoint ?? '/mcp';
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const maxSessions = opts.maxSessions ?? 100;
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const log = opts.services.logger;
  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...(opts.allowedHosts ?? []).map((h) => hostnameOf(h)),
  ]);
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  const limiter = new RateLimiter(opts.rateLimitPerMinute ?? 120, 60_000);
  const authFailures = new RateLimiter(20, 60_000);
  const sessions = new Map<string, Session>();
  const runs = new RunManager(opts.services);

  const originAllowed = (origin: string): boolean => {
    if (allowedOrigins.has(origin.toLowerCase())) return true;
    try {
      const u = new URL(origin);
      return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname);
    } catch {
      return false;
    }
  };

  const send = (
    res: ServerResponse,
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  };

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBody) throw new HttpError(413, 'request body too large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBody) throw new HttpError(413, 'request body too large');
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid JSON body');
    }
  }

  async function newSession(principal: Principal): Promise<Session> {
    if (sessions.size >= maxSessions) throw new HttpError(503, 'too many sessions');
    const { server } = buildServerWithRuns(opts.services, runs);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    const session: Session = {
      transport,
      principal: principal.id,
      lastSeen: Date.now(),
      close: async () => {
        await server.close().catch(() => {});
      },
    };
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return session;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, 'ok');

    // DNS-rebinding protection (MCP spec): validate Host and Origin before anything else.
    if (!allowedHosts.has(hostnameOf(req.headers.host ?? ''))) return send(res, 403, 'forbidden host');
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin)) return send(res, 403, 'forbidden origin');

    if (url.pathname !== endpoint) return send(res, 404, 'not found');

    const ip = req.socket.remoteAddress ?? 'unknown';
    const wait = authFailures.peek(ip);
    if (wait)
      return send(res, 429, 'too many failed authentication attempts', {
        'retry-after': String(Math.ceil(wait / 1000)),
      });

    const auth = await opts.authenticator.authenticate(req);
    if (!auth.ok) {
      authFailures.check(ip);
      log.warn({ ip, reason: auth.reason }, 'http auth rejected');
      return send(
        res,
        auth.status,
        'unauthorized',
        auth.wwwAuthenticate ? { 'www-authenticate': auth.wwwAuthenticate } : {},
      );
    }
    const { principal } = auth;
    const retry = limiter.check(principal.id);
    if (retry)
      return send(res, 429, 'rate limit exceeded', { 'retry-after': String(Math.ceil(retry / 1000)) });

    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    (req as IncomingMessage & { auth?: unknown }).auth = {
      token: '',
      clientId: principal.id,
      scopes: principal.scopes ?? [],
    };

    if (req.method === 'POST') {
      const body = await readBody(req);
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) return send(res, 404, 'unknown session');
      if (!session) {
        if (!isInitializeRequest(body))
          return send(res, 400, 'missing Mcp-Session-Id; send initialize first');
        session = await newSession(principal);
      }
      if (session.principal !== principal.id) return send(res, 403, 'session belongs to another client');
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req, res, body);
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) return send(res, 404, 'unknown session');
      if (session.principal !== principal.id) return send(res, 403, 'session belongs to another client');
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req, res);
    }
    res.setHeader('allow', 'GET, POST, DELETE');
    return send(res, 405, 'method not allowed');
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, err.message);
      log.error({ err: String(err) }, 'http handler error');
      send(res, 500, 'internal error');
    });
  });
  httpServer.requestTimeout = 5 * 60_000;
  httpServer.headersTimeout = 15_000;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        void s.close();
      }
    }
  }, 60_000);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 8787, host, resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}${endpoint}`,
    port,
    server: httpServer,
    async close() {
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map((s) => s.close()));
      sessions.clear();
      await runs.idle();
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface Principal {
  /** Stable, non-secret identifier; used as audit actor and rate-limit key. */
  id: string;
  scopes?: string[];
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; wwwAuthenticate?: string; reason: string };

/**
 * Pluggable HTTP authentication. BearerAuthenticator is the built-in implementation.
 *
 * OAuth 2.1 resource-server hook (not implemented yet): implement this interface to validate a JWT access
 * token (signature via the authorization server's JWKS, `iss`, `aud` equal to this server's resource URL
 * per RFC 8707, `exp`, scopes) and return the `sub`/`client_id` as Principal.id. On failure return
 * `{ ok:false, status:401, wwwAuthenticate:'Bearer resource_metadata="https://host/.well-known/oauth-protected-resource"' }`
 * and serve that RFC 9728 metadata document from an extra route. Pass the instance as `authenticator` to
 * startHttpServer; nothing else changes.
 */
export interface Authenticator {
  authenticate(req: IncomingMessage): Promise<AuthResult>;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface TokenEntry {
  id: string;
  sha256: string;
}

/** Parses `id:sha256hex` entries separated by commas, whitespace or newlines (AUTOWP_MCP_TOKENS). */
export function parseTokenEntries(raw: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const m = /^([A-Za-z0-9._-]+):([0-9a-f]{64})$/i.exec(part);
    if (!m) throw new Error('invalid token entry; expected <id>:<sha256 hex of the token>');
    entries.push({ id: m[1] as string, sha256: (m[2] as string).toLowerCase() });
  }
  return entries;
}

export class BearerAuthenticator implements Authenticator {
  private readonly digests: Array<{ id: string; digest: Buffer }>;

  constructor(entries: TokenEntry[]) {
    this.digests = entries.map((e) => ({ id: e.id, digest: Buffer.from(e.sha256, 'hex') }));
  }

  get size(): number {
    return this.digests.length;
  }

  async authenticate(req: IncomingMessage): Promise<AuthResult> {
    const header = req.headers.authorization;
    const m = typeof header === 'string' ? /^Bearer +(\S+)$/i.exec(header) : null;
    const fail: AuthResult = {
      ok: false,
      status: 401,
      wwwAuthenticate: 'Bearer realm="auto-wp"',
      reason: m ? 'invalid token' : 'missing bearer token',
    };
    if (!m) return fail;
    const presented = createHash('sha256')
      .update(m[1] as string)
      .digest();
    // Compare against every entry (no early exit) so timing does not reveal which token matched.
    let match: string | undefined;
    for (const d of this.digests) {
      if (timingSafeEqual(presented, d.digest) && match === undefined) match = d.id;
    }
    return match === undefined ? fail : { ok: true, principal: { id: match } };
  }
}

/** Fixed-window limiter keyed by string. */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when allowed, else the milliseconds until the window resets. */
  check(key: string): number {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      return 0;
    }
    if (h.count >= this.limit) return this.windowMs - (t - h.windowStart);
    h.count++;
    return 0;
  }

  /** Like check() but does not count a hit. */
  peek(key: string): number {
    const h = this.hits.get(key);
    if (!h) return 0;
    const elapsed = this.now() - h.windowStart;
    return elapsed >= this.windowMs || h.count < this.limit ? 0 : this.windowMs - elapsed;
  }

  private sweep(t: number): void {
    for (const [k, h] of this.hits) if (t - h.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

import { createHash } from 'node:crypto';
import { AgentError, CapabilityError, canonicalString, HEADERS, PathJailError } from '@auto-wp/contracts';
import { MemoryLogger } from '@auto-wp/contracts/fakes';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnectionFactory, createSigner, TransportSecurityError } from '../src/index.js';
import { CAPS, json, makeConn, SECRET_REF, startServer, vectors } from './helpers.js';

const servers: Array<{ close(): Promise<void> }> = [];
async function srv(h: Parameters<typeof startServer>[0]) {
  const s = await startServer(h);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('signing vectors', () => {
  for (const alg of ['ed25519', 'hmac-sha256'] as const) {
    for (const v of vectors.requests) {
      it(`${alg} ${v.name} reproduces byte-for-byte`, async () => {
        const seen: Record<string, string>[] = [];
        const bodies: string[] = [];
        const { conn } = makeConn({
          endpoint: `http://127.0.0.1:1${v.path}`,
          algorithm: alg,
          clock: { now: () => new Date(v.timestamp * 1000) },
          nonce: () => v.nonce,
          fetch: async (_u, init) => {
            seen.push(init.headers as Record<string, string>);
            bodies.push(init.body as string);
            const action = JSON.parse(v.body).action;
            const result =
              action === 'probe'
                ? CAPS
                : action === 'fs.stat'
                  ? null
                  : { tables: [], bytes: 0, sha256: 'x', method: 'native' };
            return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
          },
        });
        const { action, params } = JSON.parse(v.body);
        await conn.call(action, params);
        expect(bodies[0]).toBe(v.body);
        const h = seen[0] as Record<string, string>;
        expect(h[HEADERS.signature]).toBe(
          alg === 'ed25519' ? v.ed25519SignatureB64 : v.hmacSha256SignatureB64,
        );
        expect(h[HEADERS.nonce]).toBe(v.nonce);
        expect(h[HEADERS.timestamp]).toBe(String(v.timestamp));
        expect(h[HEADERS.algorithm]).toBe(alg);
        expect(canonicalString({ ...v, body: v.body })).toBe(v.canonical);
      });
    }
  }
});

describe('wire format against mock server', () => {
  it('sends the documented headers and a verifiable signature', async () => {
    const s = await srv((_r, res) => json(res, { ok: true, result: CAPS }));
    const { conn } = makeConn({ endpoint: s.url });
    await conn.probe();
    const r = s.reqs[0];
    expect(r?.method).toBe('POST');
    expect(r?.headers['content-type']).toBe('application/json');
    expect(r?.headers['x-autowp-site']).toBe('site-agent');
    expect(r?.headers['x-autowp-key-id']).toBe(vectors.keyId);
    expect(r?.headers['x-autowp-alg']).toBe('ed25519');
    expect(r?.headers['x-autowp-nonce']).toMatch(/^[A-Za-z0-9_-]{22}$|^nonce/);
    const canonical = canonicalString({
      method: 'POST',
      path: '/auto-wp-agent/agent.php',
      timestamp: Number(r?.headers['x-autowp-timestamp']),
      nonce: String(r?.headers['x-autowp-nonce']),
      siteId: 'site-agent',
      body: r?.body ?? '',
    });
    expect(canonical.split('\n')[6]).toBe(
      createHash('sha256')
        .update(r?.body ?? '')
        .digest('hex'),
    );
    expect(String(r?.headers['x-autowp-signature'])).toBe(
      createSigner('ed25519', vectors.ed25519.seedB64).sign(canonical),
    );
  });

  it('default nonce is 22 url-safe chars and unique', async () => {
    const s = await srv((_r, res) => json(res, { ok: true, result: CAPS }));
    const { conn } = makeConn({ endpoint: s.url, nonce: undefined });
    // makeConn spreads `nonce: undefined` over its own, falling back to the default generator
    await conn.probe();
    await conn.probe();
    const n = s.reqs.map((r) => String(r.headers['x-autowp-nonce']));
    expect(n[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(n[0]).not.toBe(n[1]);
  });

  it('maps {ok:false} to AgentError and validates params', async () => {
    const s = await srv((_r, res) =>
      json(res, { ok: false, error: { code: 'path_jail', message: 'nope' } }, 400),
    );
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.stat('a')).rejects.toMatchObject({ name: 'AgentError', code: 'path_jail' });
    await expect(conn.call('fs.readChunk', { path: 'a', offset: -1, length: 1 } as any)).rejects.toThrow();
    expect(s.reqs).toHaveLength(1);
  });

  it('rejects invalid results', async () => {
    const s = await srv((_r, res) => json(res, { ok: true, result: { nope: 1 } }));
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.probe()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('404 gives a clear error', async () => {
    const s = await srv((_r, res) => {
      res.writeHead(404).end();
    });
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.probe()).rejects.toThrow(/agent unreachable or auth rejected/);
    expect(s.reqs).toHaveLength(1);
  });

  it('refuses redirects', async () => {
    const s = await srv((_r, res) => {
      res.writeHead(302, { location: 'https://evil.example/' }).end();
    });
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.probe()).rejects.toBeInstanceOf(TransportSecurityError);
    expect(s.reqs).toHaveLength(1);
  });

  it('times out and retries idempotent calls', async () => {
    const s = await srv((_r, res, n) => {
      if (n === 1) return; // never answer
      json(res, { ok: true, result: CAPS });
    });
    const { conn } = makeConn({ endpoint: s.url, requestTimeoutMs: 100 });
    await expect(conn.probe()).resolves.toMatchObject({ phpVersion: '8.4.0' });
    expect(s.reqs).toHaveLength(2);
  });

  it('exec throws CapabilityError', async () => {
    const { conn } = makeConn({ endpoint: 'http://127.0.0.1:1/a.php' });
    await expect(conn.exec(['ls'])).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects path traversal client-side', async () => {
    const { conn } = makeConn({ endpoint: 'http://127.0.0.1:1/a.php' });
    await expect(conn.readFile('../etc/passwd')).rejects.toBeInstanceOf(PathJailError);
  });
});

describe('retries', () => {
  it('retries 5xx for idempotent actions with a new nonce each time', async () => {
    const s = await srv((_r, res, n) =>
      n < 3
        ? json(res, { ok: false, error: { code: 'internal', message: 'x' } }, 500)
        : json(res, { ok: true, result: null }),
    );
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.stat('a')).resolves.toBeNull();
    const nonces = s.reqs.map((r) => r.headers['x-autowp-nonce']);
    expect(new Set(nonces).size).toBe(3);
  });

  it('gives up after maxAttempts and surfaces the agent error', async () => {
    const s = await srv((_r, res) =>
      json(res, { ok: false, error: { code: 'internal', message: 'boom' } }, 500),
    );
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.stat('a')).rejects.toMatchObject({ code: 'internal' });
    expect(s.reqs).toHaveLength(3);
  });

  it('retries network errors', async () => {
    let n = 0;
    const { conn } = makeConn({
      endpoint: 'http://127.0.0.1:1/a.php',
      fetch: async () => {
        if (++n < 2) throw new Error('ECONNRESET');
        return new Response(JSON.stringify({ ok: true, result: null }));
      },
    });
    await expect(conn.stat('a')).resolves.toBeNull();
    expect(n).toBe(2);
  });

  it('does not retry non-idempotent actions', async () => {
    const s = await srv((_r, res) => res.writeHead(502).end());
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.mkdir('a')).rejects.toBeInstanceOf(AgentError);
    await expect(conn.call('lock.acquire', { runId: 'r' })).rejects.toBeInstanceOf(AgentError);
    expect(s.reqs).toHaveLength(2);
  });
});

describe('jobs', () => {
  it('polls job.status with fresh nonces and reports progress', async () => {
    const dump = { tables: [], bytes: 5, sha256: 'abc', method: 'native' };
    const s = await srv((r, res) => {
      const b = JSON.parse(r.body);
      if (b.action === 'db.dump') return json(res, { ok: true, job: { jobId: 'j1' } });
      expect(b).toEqual({ action: 'job.status', params: { jobId: 'j1' } });
      const polls = s.reqs.filter((x) => x.body.includes('job.status')).length;
      if (polls < 3) {
        return json(res, {
          ok: true,
          result: { jobId: 'j1', state: 'running', progress: { done: polls, total: 3 } },
        });
      }
      json(res, {
        ok: true,
        result: { jobId: 'j1', state: 'done', progress: { done: 3, total: 3 }, result: dump },
      });
    });
    const { conn } = makeConn({ endpoint: s.url });
    const seen: number[] = [];
    const out = await conn.call('db.dump', { dest: 'x.sql.gz' }, { onProgress: (p) => seen.push(p.done) });
    expect(out).toEqual(dump);
    expect(seen).toEqual([1, 2, 3]);
    expect(new Set(s.reqs.map((r) => r.headers['x-autowp-nonce'])).size).toBe(4);
  });

  it('failed job becomes AgentError', async () => {
    const s = await srv((r, res) => {
      if (r.body.includes('db.dump')) return json(res, { ok: true, job: { jobId: 'j' } });
      json(res, {
        ok: true,
        result: {
          jobId: 'j',
          state: 'failed',
          progress: { done: 0 },
          error: { code: 'internal', message: 'disk full' },
        },
      });
    });
    const { conn } = makeConn({ endpoint: s.url });
    await expect(conn.call('db.dump', { dest: 'x' })).rejects.toMatchObject({
      code: 'internal',
      message: 'disk full',
    });
  });
});

describe('probe', () => {
  it('accepts matching pinned sha and refuses mismatch', async () => {
    const s = await srv((_r, res) => json(res, { ok: true, result: { ...CAPS, agentSha256: 'ABC123' } }));
    const mk = (sha: string) => {
      const m = makeConn({ endpoint: s.url });
      return new (m.conn.constructor as new (d: unknown) => typeof m.conn)({
        siteId: 'site-agent',
        config: {
          kind: 'agent',
          endpoint: s.url,
          keyId: 'k',
          signingKeyRef: SECRET_REF,
          algorithm: 'ed25519',
          insecureHttpLoopback: true,
          agentSha256: sha,
        },
        secrets: { get: async () => vectors.ed25519.seedB64 },
        logger: m.logger,
        sleep: async () => {},
      });
    };
    await expect(mk('abc123').probe()).resolves.toBeDefined();
    await expect(mk('deadbeef').probe()).rejects.toThrow(/tampering suspected/);
  });
});

describe('TLS matrix', () => {
  const open = (endpoint: string, insecureHttpLoopback: boolean) =>
    new AgentConnectionFactory({
      secrets: { get: async () => vectors.ed25519.seedB64, set: async () => {}, delete: async () => {} },
      logger: new MemoryLogger(),
    }).open({
      id: 'site-agent',
      name: 's',
      url: 'https://example.com',
      transport: {
        kind: 'agent',
        endpoint,
        keyId: 'k',
        signingKeyRef: SECRET_REF,
        algorithm: 'ed25519',
        insecureHttpLoopback,
      },
    } as any);

  const cases: Array<[string, boolean, boolean]> = [
    ['https://example.com/a.php', false, true],
    ['https://example.com/a.php', true, true],
    ['http://example.com/a.php', false, false],
    ['http://example.com/a.php', true, false],
    ['http://127.0.0.1/a.php', false, false],
    ['http://127.0.0.1/a.php', true, true],
    ['http://127.5.6.7/a.php', true, true],
    ['http://localhost:8080/a.php', true, true],
    ['http://[::1]:8080/a.php', true, true],
    ['http://128.0.0.1/a.php', true, false],
    ['http://127.0.0.1.evil.com/a.php', true, false],
    ['ftp://127.0.0.1/a.php', true, false],
  ];
  for (const [url, flag, allowed] of cases) {
    it(`${url} insecureHttpLoopback=${flag} -> ${allowed ? 'ok' : 'refused'}`, async () => {
      if (allowed) await expect(open(url, flag)).resolves.toBeDefined();
      else await expect(open(url, flag)).rejects.toBeInstanceOf(TransportSecurityError);
    });
  }

  it('factory refuses other transport kinds', async () => {
    const f = new AgentConnectionFactory({
      secrets: { get: async () => '', set: async () => {}, delete: async () => {} },
      logger: new MemoryLogger(),
    });
    await expect(f.open({ id: 's', transport: { kind: 'ssh' } } as any)).rejects.toThrow(/cannot open/);
  });
});

describe('secrets', () => {
  it('never appear in errors or logs', async () => {
    const s = await srv((_r, res) => res.writeHead(503).end('oops'));
    const { conn, logger, secret } = makeConn({ endpoint: s.url });
    const err = await conn.probe().catch((e) => e);
    const all = JSON.stringify([String(err), err.stack, logger.lines]);
    expect(all).not.toContain(secret);
    const wrong = await new Promise<Error>((resolve) => {
      const m = makeConn({
        endpoint: s.url,
        secrets: { get: async () => 'c2hvcnQ=', set: async () => {}, delete: async () => {} },
      });
      m.conn.probe().catch(resolve);
    });
    expect(wrong.message).toMatch(/32-byte seed/);
    expect(wrong.message).not.toContain('c2hvcnQ=');
  });
});

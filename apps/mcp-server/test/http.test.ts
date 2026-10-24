import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BearerAuthenticator, parseTokenEntries, RateLimiter, sha256Hex } from '../src/auth.js';
import { createFakeServices } from '../src/container.js';
import { type RunningHttpServer, startHttpServer } from '../src/http.js';

const TOKEN = 'awp_test-token-123';
const authenticator = () => new BearerAuthenticator(parseTokenEntries(`ci:${sha256Hex(TOKEN)}`));
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};
const headers = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...extra,
});

let srv: RunningHttpServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});
const start = async (o: Partial<Parameters<typeof startHttpServer>[0]> = {}) =>
  (srv = await startHttpServer({
    services: createFakeServices(),
    authenticator: authenticator(),
    port: 0,
    ...o,
  }));

describe('streamable HTTP', () => {
  it('rejects without a token, with a wrong token; accepts the right one', async () => {
    const s = await start();
    const post = (h: Record<string, string>) =>
      fetch(s.url, { method: 'POST', headers: headers(h), body: JSON.stringify(INIT) });
    const none = await post({});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await post({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('serves tools/list through the real client', async () => {
    const s = await start();
    const client = new Client({ name: 't', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBe(18);
    const sites = await client.callTool({ name: 'sites_list', arguments: {} });
    expect((sites.structuredContent as { sites: unknown[] }).sites).toHaveLength(1);
    await client.close();
  });

  it('rejects a foreign Origin and a foreign Host, allows configured ones', async () => {
    const s = await start({ allowedHosts: ['mcp.example.com'], allowedOrigins: ['https://app.example.com'] });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const post = (h: Record<string, string>) =>
      fetch(s.url, { method: 'POST', headers: headers({ ...auth, ...h }), body: JSON.stringify(INIT) });
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ origin: 'null' })).status).toBe(403);
    expect((await post({ origin: 'https://app.example.com' })).status).toBe(200);
    expect((await post({ origin: 'http://localhost:3000' })).status).toBe(200);
    expect((await post({ host: 'mcp.example.com' })).status).toBe(200);
  });

  it('rejects oversized bodies and rate limits per token', async () => {
    const s = await start({ maxBodyBytes: 200, rateLimitPerMinute: 3 });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const big = await fetch(s.url, {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify({ ...INIT, pad: 'x'.repeat(500) }),
    });
    expect(big.status).toBe(413);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push((await fetch(s.url, { method: 'GET', headers: headers(auth) })).status);
    expect(codes).toContain(429);
  });

  it('requires a session for non-initialize requests', async () => {
    const s = await start();
    const r = await fetch(s.url, {
      method: 'POST',
      headers: headers({ authorization: `Bearer ${TOKEN}` }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(r.status).toBe(400);
  });

  it('refuses a non-loopback bind without allowRemote', async () => {
    await expect(
      startHttpServer({
        services: createFakeServices(),
        authenticator: authenticator(),
        host: '0.0.0.0',
        port: 0,
      }),
    ).rejects.toThrow(/allow-remote/);
    const s = await start({ host: '0.0.0.0', allowRemote: true });
    expect(s.port).toBeGreaterThan(0);
  });
});

describe('auth helpers', () => {
  it('rejects malformed token entries', () => {
    expect(() => parseTokenEntries('ci:plaintext')).toThrow();
    expect(parseTokenEntries('')).toEqual([]);
  });
  it('rate limiter resets after the window', () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, () => t);
    expect([l.check('a'), l.check('a')]).toEqual([0, 0]);
    expect(l.check('a')).toBeGreaterThan(0);
    t = 1001;
    expect(l.check('a')).toBe(0);
  });
});

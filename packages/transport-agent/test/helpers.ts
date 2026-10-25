import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemorySecretStore, MemoryLogger } from '@auto-wp/contracts/fakes';
import vectors from '@auto-wp/contracts/test-vectors.json' with { type: 'json' };
import { type AgentConnectionDeps, AgentSiteConnection } from '../src/index.js';

export { vectors };
export const SECRET_REF = 'secret:agent-key';

export interface Recorded {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}
export type Handler = (r: Recorded, res: ServerResponse, n: number) => void;

export async function startServer(
  handler: Handler,
): Promise<{ url: string; reqs: Recorded[]; close(): Promise<void> }> {
  const reqs: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      reqs.push(r);
      handler(r, res, reqs.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/auto-wp-agent/agent.php`,
    reqs,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function makeConn(
  over: Partial<AgentConnectionDeps> & { endpoint: string; algorithm?: 'ed25519' | 'hmac-sha256' },
) {
  const { endpoint, algorithm = 'ed25519', ...rest } = over;
  const secret = algorithm === 'ed25519' ? vectors.ed25519.seedB64 : vectors.hmac.keyB64;
  const logger = new MemoryLogger();
  const secrets = new InMemorySecretStore({ [SECRET_REF]: secret });
  let n = 0;
  const conn = new AgentSiteConnection({
    siteId: 'site-agent',
    config: {
      kind: 'agent',
      endpoint,
      keyId: vectors.keyId,
      signingKeyRef: SECRET_REF,
      algorithm,
      insecureHttpLoopback: true,
    },
    secrets,
    logger,
    sleep: async () => {},
    nonce: () => `nonce${String(++n).padStart(17, '0')}`,
    ...rest,
  });
  return { conn, logger, secret };
}

export const CAPS = {
  shell: false,
  execEnabled: false,
  phpVersion: '8.4.0',
  wpCli: { available: false },
  binaries: {},
  sodium: true,
  docroot: '/var/www',
  wpRoot: '/var/www',
};

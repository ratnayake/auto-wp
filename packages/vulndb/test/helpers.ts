import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tmpCache = (): Promise<string> => mkdtemp(join(tmpdir(), 'vulndb-'));

export interface TestServer {
  url: string;
  requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

export async function startServer(handler: Parameters<typeof createServer>[1] & {}): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

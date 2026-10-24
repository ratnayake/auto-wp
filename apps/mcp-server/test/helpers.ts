import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';
import { createFakeServices, type FakeServices } from '../src/container.js';
import { RunManager } from '../src/runs.js';
import { buildServerWithRuns } from '../src/server.js';

export async function connect(
  overrides: Partial<FakeServices> = {},
  capabilities: ClientCapabilities = {},
  setup?: (c: Client) => void,
) {
  const services = createFakeServices({ defaultActor: 'test', ...overrides });
  const runs = new RunManager(services);
  const { server } = buildServerWithRuns(services, runs);
  const client = new Client({ name: 'test', version: '0' }, { capabilities });
  setup?.(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return r as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: any;
    };
  };
  const waitRun = async (runId: string) => {
    let last: any;
    await vi.waitFor(async () => {
      last = (await call('run_status', { runId })).structuredContent.run;
      if (last.status === 'running') throw new Error('still running');
    });
    return last;
  };
  return { client, server, services, runs, call, waitRun };
}

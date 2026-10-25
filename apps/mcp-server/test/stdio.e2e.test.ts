import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('stdio server answers initialize and tools/list', async () => {
  const cwd = resolve(import.meta.dirname, '..');
  const child = spawn('pnpm', ['exec', 'tsx', 'src/main.ts', '--stdio'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const deadline = Date.now() + 25_000;
  const lines = () =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  while (Date.now() < deadline && !lines().some((m) => m.id === 2))
    await new Promise((r) => setTimeout(r, 100));
  child.kill();
  const msgs = lines();
  expect(msgs.find((m) => m.id === 1)?.result.serverInfo.name).toBe('auto-wp');
  expect(msgs.find((m) => m.id === 2)?.result.tools).toHaveLength(18);
}, 40_000);

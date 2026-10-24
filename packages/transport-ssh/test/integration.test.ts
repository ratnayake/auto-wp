import { readFile } from 'node:fs/promises';
import { PathJailError } from '@auto-wp/contracts';
import { MemoryLogger } from '@auto-wp/contracts/fakes';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { HostKeyMismatchError, SshConnectionFactory, type SshSiteConnection } from '../src/index.js';

const fx = inject('sshFixture');

describe.skipIf(!fx)('ssh integration (docker)', () => {
  let conn: SshSiteConnection;
  const config = () => ({
    kind: 'ssh' as const,
    host: fx?.host ?? '',
    port: fx?.port ?? 22,
    username: fx?.username ?? '',
    hostKeySha256: fx?.hostKeySha256 ?? '',
    wpRoot: fx?.wpRoot ?? '',
    phpBinary: 'php',
    toolDir: '~/.auto-wp',
  });
  const factory = () =>
    new SshConnectionFactory({
      logger: new MemoryLogger(),
      agentPhpSource: () => readFile(fx?.agentPhpPath ?? ''),
      sshAgentSocket: fx?.agentSocket,
      fetcher: async () => {
        throw new Error('offline');
      },
    });

  beforeAll(() => {
    conn = factory().create('it', config());
  });
  afterAll(async () => {
    await conn?.close();
  });

  it('exec round trip with hostile argv', async () => {
    const r = await conn.exec(['printf', '%s|%s', `a b'c`, '$(echo pwned)\n"x"'], { cwd: '.' });
    expect(r).toMatchObject({ exitCode: 0, stdout: `a b'c|$(echo pwned)\n"x"` });
    const pwd = await conn.exec(['pwd']);
    expect(pwd.stdout.trim()).toBe(fx?.wpRoot);
    const env = await conn.exec(['sh', '-c', 'cat; echo "$FOO"'], { env: { FOO: 'b ar' }, stdin: 'in\n' });
    expect(env.stdout).toBe('in\nb ar\n');
    expect((await conn.exec(['sh', '-c', 'echo e >&2; exit 4'])).exitCode).toBe(4);
  });

  it('exec timeout kills the channel', async () => {
    await expect(conn.exec(['sleep', '30'], { timeoutMs: 500 })).rejects.toThrow(/timed out/);
    expect((await conn.exec(['echo', 'still alive'])).stdout).toBe('still alive\n');
  });

  it('sftp read/write/list/rename/remove', async () => {
    await conn.mkdir('d/e', { recursive: true });
    await conn.writeFile('d/e/a.txt', 'hello', { mode: 0o600 });
    await conn.writeFile('d/e/a.txt', 'hello again');
    expect((await conn.readFile('d/e/a.txt')).toString()).toBe('hello again');
    expect(await conn.stat('d/e/a.txt')).toMatchObject({ type: 'file', size: 11 });
    expect((await conn.list('d/e')).map((s) => s.path)).toEqual([`${fx?.wpRoot}/d/e/a.txt`]);
    await conn.rename('d/e/a.txt', 'd/b.txt');
    expect(await conn.stat('d/e/a.txt')).toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of await conn.download('d/b.txt', { offset: 6 })) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('again');
    await conn.remove('d', { recursive: true });
    expect(await conn.stat('d')).toBeNull();
  });

  it('enforces the path jail on the real server, including symlink escapes', async () => {
    await expect(conn.readFile('../.ssh/authorized_keys')).rejects.toBeInstanceOf(PathJailError);
    await expect(conn.readFile('/etc/passwd')).rejects.toBeInstanceOf(PathJailError);
    await conn.exec(['ln', '-sfn', '/etc', 'escape']);
    await expect(conn.readFile('escape/passwd')).rejects.toBeInstanceOf(PathJailError);
    await conn.remove('escape');
  });

  it('refuses a mismatching host key pin', async () => {
    const bad = factory().create('it', { ...config(), hostKeySha256: `SHA256:${'A'.repeat(43)}` });
    await expect(bad.connect()).rejects.toBeInstanceOf(HostKeyMismatchError);
    await bad.close();
  });

  it('probe() deploys the agent and merges the stub agent probe', async () => {
    const caps = await conn.probe();
    expect(caps).toMatchObject({
      shell: true,
      wpRoot: fx?.wpRoot,
      outsideDocrootDir: '/home/tester/outside',
      wpCli: { available: false },
    });
    expect(caps.phpVersion).toMatch(/^8\./);
    expect(caps.binaries.tar).toBeTruthy();
    expect(caps.agentSha256).toMatch(/^[0-9a-f]{64}$/);
    await conn.writeFile('/home/tester/outside/x.txt', 'ok');
    await expect(conn.call('fs.stat', { path: 'x' })).rejects.toMatchObject({ code: 'unknown_action' });
  });
});

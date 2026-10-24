import { createHash } from 'node:crypto';
import { AgentError, PathJailError } from '@auto-wp/contracts';
import { describe, expect, it } from 'vitest';
import { ExecTimeoutError, fetchWpCliPhar, HostKeyMismatchError, WP_CLI_PHAR_URL } from '../src/index.js';
import { type ExecReply, type Harness, makeHarness } from './helpers.js';

const ok = (result: unknown): ExecReply => ({ stdout: JSON.stringify({ ok: true, result }) });
const AGENT = '/home/u/.auto-wp/agent.php';
const sha = (b: Buffer | string, alg = 'sha256') => createHash(alg).update(b).digest('hex');

const probeResult = {
  shell: false,
  execEnabled: true,
  phpVersion: '8.3.1',
  wpCli: { available: false },
  binaries: { tar: '/agent/tar' },
  sodium: false,
  docroot: '/home/u/public_html',
  wpRoot: '/home/u/public_html',
  outsideDocrootDir: '/home/u',
};

async function withAgent(
  h: Harness,
  handler: (cmd: string, stdin: string) => ExecReply | Promise<ExecReply>,
) {
  h.client.execHandler = (cmd, stdin) => handler(cmd, stdin.toString());
}

describe('connect + host key', () => {
  it('uses agent auth only, keepalive and connect timeout', async () => {
    const h = await makeHarness();
    await h.conn.connect();
    const o = h.client.connectOpts as Record<string, unknown>;
    expect(o.agent).toBe('/tmp/agent.sock');
    expect(o.privateKey).toBeUndefined();
    expect(o.password).toBeUndefined();
    expect(o.keepaliveInterval).toBeGreaterThan(0);
    expect(o.readyTimeout).toBeGreaterThan(0);
  });

  it('refuses a host key that does not match the pinned fingerprint', async () => {
    const h = await makeHarness({ presentedKey: Buffer.from('attacker-key') });
    await expect(h.conn.connect()).rejects.toBeInstanceOf(HostKeyMismatchError);
    await expect(h.conn.exec(['id'])).rejects.toThrow(/Host key mismatch/);
    expect(h.client.commands).toEqual([]);
  });

  it('fails clearly without an ssh-agent socket', async () => {
    const h = await makeHarness();
    const prev = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '';
    try {
      const { SshSiteConnection } = await import('../src/index.js');
      const c = new SshSiteConnection(
        's',
        { ...h.conn['config'] },
        { ...h.conn['deps'], sshAgentSocket: undefined },
      );
      await expect(c.connect()).rejects.toThrow(/SSH_AUTH_SOCK/);
    } finally {
      if (prev === undefined) process.env.SSH_AUTH_SOCK = undefined as never;
      else process.env.SSH_AUTH_SOCK = prev;
    }
  });
});

describe('exec', () => {
  it('quotes argv, runs in wpRoot, passes env and stdin, returns results', async () => {
    const h = await makeHarness();
    await withAgent(h, () => ({ stdout: 'out', stderr: 'err', code: 3 }));
    const r = await h.conn.exec(['echo', 'a b', `it's`, '$(whoami)', 'x\ny'], {
      env: { FOO: 'bar baz' },
      stdin: 'input',
    });
    expect(r).toMatchObject({ exitCode: 3, stdout: 'out', stderr: 'err' });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(h.client.commands[0]).toBe(
      `cd '/home/u/public_html' && FOO='bar baz' exec 'echo' 'a b' 'it'\\''s' '$(whoami)' 'x\ny'`,
    );
    expect(h.client.streams[0]?.stdin.toString()).toBe('input');
  });

  it('rejects bad env names', async () => {
    const h = await makeHarness();
    await expect(h.conn.exec(['id'], { env: { 'a;b': '1' } })).rejects.toThrow(/invalid environment/);
    expect(h.client.commands).toEqual([]);
  });

  it('resolves relative cwd against wpRoot and jails it', async () => {
    const h = await makeHarness();
    h.sftp.mkdirs('/home/u/public_html/wp-content');
    await h.conn.exec(['ls'], { cwd: 'wp-content' });
    expect(h.client.commands[0]).toMatch(/^cd '\/home\/u\/public_html\/wp-content' && exec/);
    await expect(h.conn.exec(['ls'], { cwd: '/etc' })).rejects.toBeInstanceOf(PathJailError);
  });

  it('kills the channel on timeout', async () => {
    const h = await makeHarness();
    await withAgent(h, () => ({ hang: true }));
    await expect(h.conn.exec(['sleep', '99'], { timeoutMs: 20 })).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(h.client.streams[0]?.closedByClient).toBe(true);
  });
});

describe('path jail', () => {
  it('resolves relative paths against wpRoot', async () => {
    const h = await makeHarness();
    h.sftp.files.set('/home/u/public_html/a.txt', Buffer.from('hi'));
    expect((await h.conn.readFile('a.txt')).toString()).toBe('hi');
    expect((await h.conn.stat('a.txt'))?.path).toBe('/home/u/public_html/a.txt');
  });

  it.each([
    '../secret',
    'a/../../x',
    '/etc/passwd',
    '/home/u/public_html/../.ssh/id',
    '/home/u/public_html-evil/x',
    '',
    'a\0b',
  ])('rejects %j', async (p) => {
    const h = await makeHarness();
    await expect(h.conn.readFile(p)).rejects.toBeInstanceOf(PathJailError);
    await expect(h.conn.writeFile(p, 'x')).rejects.toBeInstanceOf(PathJailError);
    await expect(h.conn.remove(p)).rejects.toBeInstanceOf(PathJailError);
    await expect(h.conn.rename(p, 'ok')).rejects.toBeInstanceOf(PathJailError);
  });

  it('rejects a symlink inside wpRoot pointing outside (mocked realpath)', async () => {
    const h = await makeHarness();
    h.sftp.mkdirs('/home/u/secret');
    h.sftp.files.set('/home/u/secret/key', Buffer.from('K'));
    h.sftp.links.set('/home/u/public_html/escape', '/home/u/secret');
    await expect(h.conn.readFile('escape/key')).rejects.toBeInstanceOf(PathJailError);
    await expect(h.conn.writeFile('escape/new', 'x')).rejects.toBeInstanceOf(PathJailError);
    await expect(h.conn.list('escape')).rejects.toBeInstanceOf(PathJailError);
  });

  it('allows lstat/remove of the symlink itself and does not follow it', async () => {
    const h = await makeHarness();
    h.sftp.mkdirs('/home/u/secret');
    h.sftp.links.set('/home/u/public_html/escape', '/home/u/secret');
    expect((await h.conn.stat('escape'))?.type).toBe('symlink');
    await h.conn.remove('escape', { recursive: true });
    expect(h.sftp.links.has('/home/u/public_html/escape')).toBe(false);
    expect(h.sftp.dirs.has('/home/u/secret')).toBe(true);
  });

  it('accepts a wpRoot that is itself a symlink', async () => {
    const h = await makeHarness();
    h.sftp.mkdirs('/srv/real');
    h.sftp.files.set('/srv/real/f', Buffer.from('z'));
    h.sftp.dirs.delete('/home/u/public_html');
    h.sftp.links.set('/home/u/public_html', '/srv/real');
    expect((await h.conn.readFile('f')).toString()).toBe('z');
  });

  it('allows outsideDocrootDir after probe reports it', async () => {
    const h = await makeHarness();
    await expect(h.conn.writeFile('/home/u/backups/x', 'x')).rejects.toBeInstanceOf(PathJailError);
    await withAgent(h, (cmd) =>
      cmd.includes(`'--cli' 'probe'`) ? ok(probeResult) : { stdout: 'php_bin=/usr/bin/php\n' },
    );
    await h.conn.probe();
    h.sftp.mkdirs('/home/u/backups');
    await h.conn.writeFile('/home/u/backups/x', 'x');
    expect(h.sftp.files.get('/home/u/backups/x')?.toString()).toBe('x');
  });
});

describe('file operations', () => {
  it('writeFile is atomic (temp + rename) and sets mode', async () => {
    const h = await makeHarness();
    h.sftp.files.set('/home/u/public_html/f', Buffer.from('old'));
    await h.conn.writeFile('f', 'new', { mode: 0o600 });
    expect(h.sftp.files.get('/home/u/public_html/f')?.toString()).toBe('new');
    expect(h.sftp.modes.get('/home/u/public_html/f')).toBe(0o600);
    expect([...h.sftp.files.keys()].filter((k) => k.includes('auto-wp-tmp'))).toEqual([]);
  });

  it('cleans the temp file when rename fails', async () => {
    const h = await makeHarness();
    h.sftp.rename = (_a, _b, cb) => cb(new Error('boom'));
    await expect(h.conn.writeFile('f', 'x')).rejects.toThrow('boom');
    expect(h.sftp.files.size).toBe(0);
  });

  it('mkdir recursive, list, rename, recursive remove, download with offset', async () => {
    const h = await makeHarness();
    await h.conn.mkdir('a/b/c', { recursive: true });
    await h.conn.writeFile('a/b/c/f.txt', 'hello world');
    const l = await h.conn.list('a/b/c');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ path: '/home/u/public_html/a/b/c/f.txt', type: 'file', size: 11 });
    await h.conn.rename('a/b/c/f.txt', 'a/g.txt');
    expect(await h.conn.stat('a/b/c/f.txt')).toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of await h.conn.download('a/g.txt', { offset: 6 })) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('world');
    await h.conn.remove('a', { recursive: true });
    expect(await h.conn.stat('a')).toBeNull();
  });

  it('refuses to remove wpRoot', async () => {
    const h = await makeHarness();
    await expect(h.conn.remove('.', { recursive: true })).rejects.toBeInstanceOf(PathJailError);
  });
});

describe('call', () => {
  it('uploads agent.php, runs it with params on stdin and validates the result', async () => {
    const h = await makeHarness();
    const seen: string[] = [];
    await withAgent(h, (cmd, stdin) => {
      seen.push(cmd, stdin);
      return ok({ sha256: 'abc', bytes: 3 });
    });
    const r = await h.conn.call('fs.sha256', { path: 'x' });
    expect(r).toEqual({ sha256: 'abc', bytes: 3 });
    expect(seen[0]).toBe(`cd '/home/u/public_html' && exec 'php' '${AGENT}' '--cli' 'fs.sha256'`);
    expect(JSON.parse(seen[1] ?? '')).toEqual({ path: 'x' });
    expect(h.sftp.files.get(AGENT)?.toString()).toBe('<?php // agent');
    expect(h.sftp.modes.get('/home/u/.auto-wp')).toBe(0o700);
  });

  it('applies schema defaults and rejects invalid params before running anything', async () => {
    const h = await makeHarness();
    await withAgent(h, () => ok({}));
    await expect(h.conn.call('fs.remove', { path: '' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(h.client.commands).toEqual([]);
    await h.conn.call('fs.mkdir', { path: 'a' });
    expect(JSON.parse(h.client.streams.at(-1)?.stdin.toString() ?? '')).toEqual({
      path: 'a',
      recursive: true,
    });
  });

  it('rejects results that fail schema validation', async () => {
    const h = await makeHarness();
    await withAgent(h, () => ok({ sha256: 5 }));
    await expect(h.conn.call('fs.sha256', { path: 'x' })).rejects.toMatchObject({
      name: 'AgentError',
      code: 'internal',
    });
  });

  it('maps {ok:false} to AgentError with the agent code', async () => {
    const h = await makeHarness();
    await withAgent(h, () => ({
      stdout: JSON.stringify({ ok: false, error: { code: 'path_jail', message: 'nope' } }),
      code: 1,
    }));
    const e = await h.conn.call('fs.stat', { path: 'x' }).catch((x) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect(e).toMatchObject({ code: 'path_jail', message: 'nope' });
  });

  it('maps non-JSON output to AgentError(internal) including stderr', async () => {
    const h = await makeHarness();
    await withAgent(h, () => ({ stdout: 'PHP Fatal', stderr: 'php: not found', code: 127 }));
    await expect(h.conn.call('fs.stat', { path: 'x' })).rejects.toThrow(/php: not found/);
  });

  it('polls job.status with backoff and progress until done', async () => {
    const h = await makeHarness();
    const progress: unknown[] = [];
    let polls = 0;
    await withAgent(h, (cmd) => {
      if (cmd.includes(`'fs.count'`)) return { stdout: JSON.stringify({ ok: true, job: { jobId: 'j1' } }) };
      polls++;
      const base = { jobId: 'j1', progress: { done: polls, total: 3 } };
      return ok(
        polls < 3
          ? { ...base, state: 'running' }
          : { ...base, state: 'done', result: { fileCount: 7, bytes: 9 } },
      );
    });
    const r = await h.conn.call('fs.count', { dir: 'x' }, { onProgress: (p) => progress.push(p) });
    expect(r).toEqual({ fileCount: 7, bytes: 9 });
    expect(progress).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 375, 563]);
  });

  it('maps a failed job to AgentError and validates the job result', async () => {
    const h = await makeHarness();
    let mode: 'fail' | 'bad' = 'fail';
    await withAgent(h, (cmd) => {
      if (cmd.includes(`'fs.count'`)) return { stdout: JSON.stringify({ ok: true, job: { jobId: 'j' } }) };
      const progress = { done: 1 };
      return mode === 'fail'
        ? ok({ jobId: 'j', state: 'failed', progress, error: { code: 'locked', message: 'busy' } })
        : ok({ jobId: 'j', state: 'done', progress, result: { nope: 1 } });
    });
    await expect(h.conn.call('fs.count', { dir: 'x' })).rejects.toMatchObject({
      code: 'locked',
      message: 'busy',
    });
    mode = 'bad';
    await expect(h.conn.call('fs.count', { dir: 'x' })).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('agent bootstrap', () => {
  it('re-uploads agent.php only when the remote sha256 differs', async () => {
    const h = await makeHarness({ agentSource: Buffer.from('v2') });
    h.sftp.mkdirs('/home/u/.auto-wp');
    h.sftp.files.set(AGENT, Buffer.from('v1-stale'));
    await withAgent(h, () => ok({ sha256: 'x', bytes: 1 }));
    await h.conn.call('fs.sha256', { path: 'x' });
    expect(h.sftp.files.get(AGENT)?.toString()).toBe('v2');

    // identical content is left alone
    const h2 = await makeHarness({ agentSource: Buffer.from('v2') });
    h2.sftp.mkdirs('/home/u/.auto-wp');
    h2.sftp.files.set(AGENT, Buffer.from('v2'));
    let writes = 0;
    const orig = h2.sftp.writeFile;
    h2.sftp.writeFile = (...a) => {
      writes++;
      return orig(...a);
    };
    await withAgent(h2, () => ok({ sha256: 'x', bytes: 1 }));
    await h2.conn.call('fs.sha256', { path: 'x' });
    expect(writes).toBe(0);
  });
});

describe('probe', () => {
  const script = (extra = '') =>
    `php_bin=/usr/bin/php\nphp_version=8.3.1\nsodium=1\nbin_tar=/bin/tar\nbin_sha256sum=/usr/bin/sha256sum\nbin_bogus=/x\ndisk_free=12345\noutside=/home/u\ndocroot=/home/u/public_html\n${extra}`;

  it('merges the shell script with the agent probe and forces shell:true', async () => {
    const h = await makeHarness();
    await withAgent(h, (cmd) =>
      cmd.includes(`'--cli' 'probe'`)
        ? ok(probeResult)
        : { stdout: script('wp_path=/usr/bin/wp\nwp_version=WP-CLI 2.11.0\n') },
    );
    const caps = await h.conn.probe();
    expect(caps).toMatchObject({
      shell: true,
      phpVersion: '8.3.1',
      phpCli: '/usr/bin/php',
      sodium: true,
      wpCli: { available: true, path: '/usr/bin/wp', version: '2.11.0' },
      binaries: { tar: '/bin/tar', sha256sum: '/usr/bin/sha256sum' },
      diskFreeBytes: 12345,
      wpRoot: '/home/u/public_html',
      agentSha256: sha('<?php // agent'),
    });
    expect(caps.binaries).not.toHaveProperty('bogus');
  });

  it('downloads wp-cli.phar, verifies sha512 and uploads when wp-cli is missing', async () => {
    const phar = Buffer.from('PHAR-BYTES');
    const urls: string[] = [];
    const h = await makeHarness({
      deps: {
        fetcher: async (u) => {
          urls.push(u);
          return u.endsWith('.sha512') ? Buffer.from(`${sha(phar, 'sha512')}  wp-cli.phar\n`) : phar;
        },
      },
    });
    let installed = false;
    await withAgent(h, (cmd) => {
      if (cmd.includes(`'--cli' 'probe'`)) return ok(probeResult);
      installed = h.sftp.files.has('/home/u/.auto-wp/wp-cli.phar');
      return {
        stdout: script(installed ? 'wp_path=/home/u/.auto-wp/wp-cli.phar\nwp_version=WP-CLI 2.11.0\n' : ''),
      };
    });
    const caps = await h.conn.probe();
    expect(urls).toEqual([WP_CLI_PHAR_URL, `${WP_CLI_PHAR_URL}.sha512`]);
    expect(h.sftp.files.get('/home/u/.auto-wp/wp-cli.phar')).toEqual(phar);
    expect(caps.wpCli).toMatchObject({ available: true, path: '/home/u/.auto-wp/wp-cli.phar' });
  });

  it('does not install a phar whose checksum is wrong', async () => {
    const h = await makeHarness({
      deps: {
        fetcher: async (u) => (u.endsWith('.sha512') ? Buffer.from('0'.repeat(128)) : Buffer.from('evil')),
      },
    });
    await withAgent(h, (cmd) => (cmd.includes(`'--cli' 'probe'`) ? ok(probeResult) : { stdout: script() }));
    const caps = await h.conn.probe();
    expect(h.sftp.files.has('/home/u/.auto-wp/wp-cli.phar')).toBe(false);
    expect(caps.wpCli.available).toBe(false);
  });

  it('survives a failing agent probe', async () => {
    const h = await makeHarness({ deps: { fetcher: async () => Buffer.alloc(0) } });
    await withAgent(h, (cmd) =>
      cmd.includes(`'--cli' 'probe'`) ? { stdout: 'garbage', code: 255 } : { stdout: script() },
    );
    const caps = await h.conn.probe();
    expect(caps).toMatchObject({ shell: true, phpVersion: '8.3.1' });
  });
});

describe('fetchWpCliPhar', () => {
  it('rejects malformed checksum files', async () => {
    await expect(fetchWpCliPhar(async () => Buffer.from('x'))).rejects.toThrow(/malformed/);
  });
});

describe('close', () => {
  it('ends sftp and the client', async () => {
    const h = await makeHarness();
    await h.conn.stat('.');
    await h.conn.close();
    expect(h.client.ended).toBe(true);
    expect(h.sftp.ended).toBe(true);
  });
});

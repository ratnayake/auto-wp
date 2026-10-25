import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteFile, expandHome, parseAppConfigText, redact, Secret, saveConfig } from '../src/index.js';
import { tempDir } from './helpers.js';

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

describe('atomicWriteFile', () => {
  it('writes content with mode 0600 and leaves no temp files behind', async () => {
    const dir = await tempDir();
    const file = join(dir, 'nested', 'config.yaml');
    await atomicWriteFile(file, 'hello\n');
    expect(await readFile(file, 'utf8')).toBe('hello\n');
    expect(await modeOf(file)).toBe(0o600);
    expect(await readdir(join(dir, 'nested'))).toEqual(['config.yaml']);
  });

  it('replaces an existing file and tightens a looser mode', async () => {
    const dir = await tempDir();
    const file = join(dir, 'x.txt');
    await writeFile(file, 'old', { mode: 0o644 });
    await atomicWriteFile(file, 'new');
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(await modeOf(file)).toBe(0o600);
  });

  it('cleans up the temp file when the rename fails', async () => {
    const dir = await tempDir();
    const target = join(dir, 'is-a-dir');
    await mkdir(target);
    await expect(atomicWriteFile(target, 'x')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['is-a-dir']);
  });

  it('saveConfig writes through a symlink and keeps the link', async () => {
    const dir = await tempDir();
    const target = join(dir, 'dotfiles-config.yaml');
    const link = join(dir, 'config.yaml');
    await writeFile(target, 'sites: []\n');
    await symlink(target, link);
    await saveConfig(parseAppConfigText('sites: []\nstateDir: /srv/state\n', 'x'), link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toMatch(/stateDir: \/srv\/state/);
  });

  it('saveConfig writes the file atomically with mode 0600', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.yaml');
    await saveConfig(parseAppConfigText('sites: []\nstateDir: /var/lib/x\n', 'x'), file);
    expect(await modeOf(file)).toBe(0o600);
    expect(await readFile(file, 'utf8')).toMatch(/stateDir: \/var\/lib\/x/);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('redaction', () => {
  it('Secret never shows its value through toString, JSON or util.inspect', async () => {
    const { inspect } = await import('node:util');
    const s = new Secret('hunter2-very-secret');
    expect(String(s)).not.toContain('hunter2');
    expect(`${s}`).not.toContain('hunter2');
    expect(JSON.stringify({ s })).not.toContain('hunter2');
    expect(inspect(s)).not.toContain('hunter2');
    expect(inspect({ nested: s })).not.toContain('hunter2');
    expect(s.reveal()).toBe('hunter2-very-secret');
  });

  it('does not mask ordinary words that contain short sensitive substrings', () => {
    expect(redact({ bypassMode: true, compass: 'n', adminPassword: 'x' })).toEqual({
      bypassMode: true,
      compass: 'n',
      adminPassword: '[REDACTED]',
    });
  });

  it('redact masks secret-looking keys in plain data but keeps secret: refs', () => {
    const out = redact({
      url: 'https://x',
      adminPassword: 'p',
      transport: { kind: 'agent', signingKeyRef: 'secret:k', apiToken: 'abc' },
      list: [{ wpscanTokenRef: 'secret:t', cookie: 'c' }],
      s: new Secret('zzz'),
    });
    expect(out).toEqual({
      url: 'https://x',
      adminPassword: '[REDACTED]',
      transport: { kind: 'agent', signingKeyRef: 'secret:k', apiToken: '[REDACTED]' },
      list: [{ wpscanTokenRef: 'secret:t', cookie: '[REDACTED]' }],
      s: '[REDACTED]',
    });
    expect(JSON.stringify(out)).not.toContain('abc');
  });

  it('expandHome expands only a leading tilde', () => {
    expect(expandHome('/abs/~/x')).toBe('/abs/~/x');
    expect(expandHome('~x')).toBe('~x');
  });
});

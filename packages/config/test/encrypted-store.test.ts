import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSecretStore,
  EncryptedFileSecretStore,
  KeyringSecretStore,
  loadSecretsKey,
  SecretStoreError,
} from '../src/index.js';
import { newKeyBase64, tempDir } from './helpers.js';

const key = () => newKeyBase64();

describe('EncryptedFileSecretStore', () => {
  it('round-trips values across instances with the same key', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets.enc');
    const k = key();
    const a = new EncryptedFileSecretStore({ path, keyBase64: k });
    await a.set('secret:wp-admin', 'correct horse');
    await a.set('secret:key-2', 'second');
    await a.delete('secret:key-2');

    const b = new EncryptedFileSecretStore({ path, keyBase64: k });
    expect(await b.get('secret:wp-admin')).toBe('correct horse');
    await expect(b.get('secret:key-2')).rejects.toThrow(/secret not found: secret:key-2/);
  });

  it('never stores plaintext on disk and uses a fresh nonce per write', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets.enc');
    const store = new EncryptedFileSecretStore({ path, keyBase64: key() });
    await store.set('secret:x', 'PLAINTEXT-MARKER-123');
    const first = JSON.parse(await readFile(path, 'utf8')) as { nonce: string; ciphertext: string };
    expect(await readFile(path, 'utf8')).not.toContain('PLAINTEXT-MARKER');
    await store.set('secret:x', 'PLAINTEXT-MARKER-123');
    const second = JSON.parse(await readFile(path, 'utf8')) as { nonce: string; ciphertext: string };
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('writes the file with mode 0600 and no temp files left behind', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets.enc');
    await new EncryptedFileSecretStore({ path, keyBase64: key() }).set('secret:a', 'b');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects a wrong key', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets.enc');
    await new EncryptedFileSecretStore({ path, keyBase64: key() }).set('secret:a', 'b');
    const wrong = new EncryptedFileSecretStore({ path, keyBase64: key() });
    await expect(wrong.get('secret:a')).rejects.toThrow(/wrong secrets key, or the file was modified/);
    await expect(wrong.set('secret:c', 'd')).rejects.toBeInstanceOf(SecretStoreError);
  });

  it('rejects tampered ciphertext', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets.enc');
    const k = key();
    await new EncryptedFileSecretStore({ path, keyBase64: k }).set('secret:a', 'b');
    const file = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      nonce: string;
      ciphertext: string;
    };
    const bytes = Buffer.from(file.ciphertext, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    file.ciphertext = bytes.toString('base64');
    await writeFile(path, JSON.stringify(file));
    await expect(new EncryptedFileSecretStore({ path, keyBase64: k }).get('secret:a')).rejects.toThrow(
      /cannot decrypt secrets file/,
    );
  });

  it('rejects a file that is not a secrets store', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets.enc');
    await writeFile(path, 'not json');
    await expect(new EncryptedFileSecretStore({ path, keyBase64: key() }).get('secret:a')).rejects.toThrow(
      /not a valid secrets store/,
    );
  });

  it('validates the key length up front without echoing the key', () => {
    const short = randomBytes(16).toString('base64');
    let message = '';
    try {
      new EncryptedFileSecretStore({ path: '/x', keyBase64: short });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/exactly 32 bytes \(got 16\)/);
    expect(message).not.toContain(short);
  });

  it('does not reveal the key through inspection', async () => {
    const { inspect } = await import('node:util');
    const k = key();
    const store = new EncryptedFileSecretStore({ path: '/x', keyBase64: k });
    expect(String(store)).not.toContain(k);
    expect(JSON.stringify({ store })).not.toContain(k);
    expect(inspect(store)).not.toContain(k);
  });

  it('treats prototype names as ordinary missing secrets', async () => {
    const dir = await tempDir();
    const store = new EncryptedFileSecretStore({ path: join(dir, 's.enc'), keyBase64: key() });
    await store.set('secret:a', 'b');
    await expect(store.get('secret:constructor')).rejects.toThrow(/secret not found/);
    await store.set('secret:toString', 'p');
    expect(await store.get('secret:toString')).toBe('p');
  });

  it('serialises concurrent writes so no update is lost', async () => {
    const dir = await tempDir();
    const store = new EncryptedFileSecretStore({ path: join(dir, 's.enc'), keyBase64: key() });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.set(`secret:k${i}`, `v${i}`)));
    for (let i = 0; i < 10; i++) expect(await store.get(`secret:k${i}`)).toBe(`v${i}`);
  });
});

describe('loadSecretsKey and createSecretStore', () => {
  it('reads the key from env first, then an explicit key file, then the systemd credentials dir', async () => {
    const dir = await tempDir();
    const fromEnv = key();
    const fromFile = key();
    const fromCreds = key();
    await writeFile(join(dir, 'file.key'), `${fromFile}\n`);
    await writeFile(join(dir, 'autowp-secrets-key'), fromCreds);

    expect(loadSecretsKey({ env: { AUTOWP_SECRETS_KEY: fromEnv }, keyFile: join(dir, 'file.key') })).toBe(
      fromEnv,
    );
    expect(loadSecretsKey({ env: {}, keyFile: join(dir, 'file.key') })).toBe(fromFile);
    expect(loadSecretsKey({ env: { CREDENTIALS_DIRECTORY: dir } })).toBe(fromCreds);
    expect(loadSecretsKey({ env: {} })).toBeUndefined();
  });

  it('reports a missing key file by path only', () => {
    expect(() => loadSecretsKey({ env: {}, keyFile: '/no/such/key' })).toThrow(
      /secrets key file \/no\/such\/key could not be read \(ENOENT\)/,
    );
  });

  it('auto picks the encrypted file when a key is present, and the keychain otherwise', () => {
    const env = { AUTOWP_SECRETS_KEY: key() };
    expect(createSecretStore({ env, secretsFile: '/tmp/none.enc' })).toBeInstanceOf(EncryptedFileSecretStore);
    expect(createSecretStore({ env: {} })).toBeInstanceOf(KeyringSecretStore);
  });

  it('treats a whitespace-only env key as absent and falls back to the keychain in auto mode', () => {
    expect(createSecretStore({ env: { AUTOWP_SECRETS_KEY: '   ' } })).toBeInstanceOf(KeyringSecretStore);
  });

  it('forces a backend when asked, and explains a missing key for the file backend', () => {
    expect(() => createSecretStore({ backend: 'encrypted-file', env: {} })).toThrow(
      /needs a key: set AUTOWP_SECRETS_KEY/,
    );
    expect(createSecretStore({ backend: 'keyring', env: { AUTOWP_SECRETS_KEY: key() } })).toBeInstanceOf(
      KeyringSecretStore,
    );
  });
});

import { readFile } from 'node:fs/promises';
import type { SecretStore } from '@auto-wp/contracts';
import { z } from 'zod';
import { atomicWriteFile } from '../atomic-file.js';
import { errorCode, firstLine, SecretStoreError } from '../errors.js';
import { secretNameOf } from '../secret-ref.js';
import { Secret } from './secret.js';

export interface EncryptedFileSecretStoreOptions {
  /** Encrypted secrets file. Written atomically with mode 0600. */
  path: string;
  /** Base64 of the 32-byte key (see `loadSecretsKey`). */
  keyBase64: string;
}

const FILE_VERSION = 1;
const KEY_BYTES = 32;

const FileSchema = z.object({
  version: z.literal(FILE_VERSION),
  nonce: z.string(),
  ciphertext: z.string(),
});
const MapSchema = z.record(z.string(), z.string());

/** Single writer assumed: there is no cross-process lock, so run one controller per secrets file. */
type SecretMap = Map<string, string>;

/**
 * Secrets as one JSON map, encrypted as a whole with libsodium secretbox (XSalsa20-Poly1305).
 * A fresh random nonce is used on every write. Operations are serialised within the process.
 */
export class EncryptedFileSecretStore implements SecretStore {
  readonly #path: string;
  readonly #key: Secret;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: EncryptedFileSecretStoreOptions) {
    decodeKey(opts.keyBase64); // fail fast on a malformed key
    this.#path = opts.path;
    this.#key = new Secret(opts.keyBase64);
  }

  get(ref: string): Promise<string> {
    const name = secretNameOf(ref);
    return this.#exclusive(async () => {
      const value = (await this.#read()).get(name);
      if (value === undefined) throw new SecretStoreError(`secret not found: ${ref}`);
      return value;
    });
  }

  set(ref: string, value: string): Promise<void> {
    const name = secretNameOf(ref);
    return this.#exclusive(async () => {
      const map = await this.#read();
      map.set(name, value);
      await this.#write(map);
    });
  }

  delete(ref: string): Promise<void> {
    const name = secretNameOf(ref);
    return this.#exclusive(async () => {
      const map = await this.#read();
      if (!map.delete(name)) return;
      await this.#write(map);
    });
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<SecretMap> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return new Map();
      throw new SecretStoreError(
        `cannot read secrets file ${this.#path}: ${errorCode(err) ?? firstLine(err)}`,
      );
    }
    const file = FileSchema.safeParse(parseJson(raw));
    if (!file.success) throw new SecretStoreError(`secrets file ${this.#path} is not a valid secrets store`);
    const plaintext = await decrypt(file.data, decodeKey(this.#key.reveal()), this.#path);
    const map = MapSchema.safeParse(parseJson(plaintext));
    if (!map.success) throw new SecretStoreError(`secrets file ${this.#path} has unexpected contents`);
    // A Map, so names such as `constructor` or `__proto__` never hit prototype lookups.
    return new Map(Object.entries(map.data));
  }

  async #write(map: SecretMap): Promise<void> {
    const sodium = await loadSodium();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const message = new TextEncoder().encode(JSON.stringify(Object.fromEntries(map)));
    const box = sodium.crypto_secretbox_easy(message, nonce, decodeKey(this.#key.reveal()));
    const file = {
      version: FILE_VERSION,
      nonce: Buffer.from(nonce).toString('base64'),
      ciphertext: Buffer.from(box).toString('base64'),
    };
    await atomicWriteFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
  }

  toString(): string {
    return 'EncryptedFileSecretStore([REDACTED])';
  }

  toJSON(): string {
    return this.toString();
  }
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretStoreError(
      `secrets key must be base64 of exactly ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function decrypt(file: z.infer<typeof FileSchema>, key: Buffer, path: string): Promise<string> {
  const sodium = await loadSodium();
  const nonce = Buffer.from(file.nonce, 'base64');
  if (nonce.length !== sodium.crypto_secretbox_NONCEBYTES) {
    throw new SecretStoreError(`secrets file ${path} has a malformed nonce`);
  }
  let opened: Uint8Array;
  try {
    opened = sodium.crypto_secretbox_open_easy(Buffer.from(file.ciphertext, 'base64'), nonce, key);
  } catch {
    throw new SecretStoreError(
      `cannot decrypt secrets file ${path}: wrong secrets key, or the file was modified or corrupted`,
    );
  }
  return new TextDecoder().decode(opened);
}

async function loadSodium() {
  const { default: sodium } = await import('libsodium-wrappers');
  await sodium.ready;
  return sodium;
}

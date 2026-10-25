import type { SecretStore } from '@auto-wp/contracts';
import type * as Keyring from '@napi-rs/keyring';
import { firstLine, SecretStoreError } from '../errors.js';
import { secretNameOf } from '../secret-ref.js';

export interface KeyringSecretStoreOptions {
  /** Keychain service name. Default `auto-wp`. */
  service?: string;
}

/** Stores secrets in the OS credential store (Keychain, Secret Service, Windows Credential Manager). */
export class KeyringSecretStore implements SecretStore {
  readonly #service: string;

  constructor(opts: KeyringSecretStoreOptions = {}) {
    this.#service = opts.service ?? 'auto-wp';
  }

  async get(ref: string): Promise<string> {
    const entry = await this.#entry(ref);
    const value = this.#call(ref, 'read', () => entry.getPassword());
    if (value === null) throw new SecretStoreError(`secret not found: ${ref}`);
    return value;
  }

  async set(ref: string, value: string): Promise<void> {
    const entry = await this.#entry(ref);
    this.#call(ref, 'write', () => entry.setPassword(value));
  }

  async delete(ref: string): Promise<void> {
    const entry = await this.#entry(ref);
    if (this.#call(ref, 'read', () => entry.getPassword()) === null) return;
    this.#call(ref, 'delete', () => entry.deletePassword());
  }

  async #entry(ref: string): Promise<Keyring.Entry> {
    const account = secretNameOf(ref);
    const { Entry } = await loadKeyring();
    return this.#call(ref, 'open', () => new Entry(this.#service, account));
  }

  #call<T>(ref: string, op: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      // Native error text can echo the account name; keep it to the first line and never add values.
      throw new SecretStoreError(`keychain ${op} failed for ${ref}: ${firstLine(err)}`);
    }
  }

  toString(): string {
    return `KeyringSecretStore(service=${this.#service})`;
  }
}

async function loadKeyring(): Promise<typeof Keyring> {
  try {
    return await import('@napi-rs/keyring');
  } catch (err) {
    throw new SecretStoreError(
      `OS keychain backend unavailable: the native module @napi-rs/keyring failed to load (${firstLine(err)}). ` +
        'Install it for this platform, or use the encrypted-file secret store (AUTOWP_SECRETS_KEY).',
    );
  }
}

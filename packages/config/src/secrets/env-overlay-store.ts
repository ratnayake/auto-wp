import type { SecretStore } from '@auto-wp/contracts';
import { secretNameOf } from '../secret-ref.js';

type Env = Record<string, string | undefined>;

/** Env var consulted for `secret:<name>`: `AUTOWP_SECRET_<NAME>`, upper-cased, non-alphanumerics as `_`. */
export function secretEnvVar(ref: string): string {
  return `AUTOWP_SECRET_${secretNameOf(ref)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Reads `AUTOWP_SECRET_<NAME>` first and falls back to `inner` (created lazily, so a keychain that cannot load
 * only fails when a secret is really needed from it). Writes and deletes always go to `inner`.
 * For systemd `Environment=`/containers and tests; values are never logged.
 */
export class EnvOverlaySecretStore implements SecretStore {
  #inner?: SecretStore;

  constructor(
    private readonly inner: () => SecretStore,
    private readonly env: Env = process.env,
  ) {}

  private store(): SecretStore {
    this.#inner ??= this.inner();
    return this.#inner;
  }

  async get(ref: string): Promise<string> {
    const v = this.env[secretEnvVar(ref)];
    if (v !== undefined && v !== '') return v;
    return this.store().get(ref);
  }

  set(ref: string, value: string): Promise<void> {
    return this.store().set(ref, value);
  }

  delete(ref: string): Promise<void> {
    return this.store().delete(ref);
  }

  toString(): string {
    return 'EnvOverlaySecretStore';
  }
}

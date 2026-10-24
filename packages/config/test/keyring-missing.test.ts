import { describe, expect, it, vi } from 'vitest';
import { KeyringSecretStore, SecretStoreError } from '../src/index.js';

vi.mock('@napi-rs/keyring', () => {
  throw new Error('Cannot find module @napi-rs/keyring-linux-x64-gnu');
});

describe('KeyringSecretStore without the native module', () => {
  it('fails with a clear error that points at the alternative backend', async () => {
    const store = new KeyringSecretStore();
    const err = await store.get('secret:a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as Error).message).toMatch(/native module @napi-rs\/keyring failed to load/);
    expect((err as Error).message).toMatch(/AUTOWP_SECRETS_KEY/);
  });
});

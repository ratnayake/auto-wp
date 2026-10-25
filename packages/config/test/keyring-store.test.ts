import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyringSecretStore, SecretStoreError } from '../src/index.js';

const { backend } = vi.hoisted(() => ({ backend: new Map<string, string>() }));

vi.mock('@napi-rs/keyring', () => {
  class Entry {
    constructor(
      readonly service: string,
      readonly account: string,
    ) {}
    private key() {
      return `${this.service}\u0000${this.account}`;
    }
    getPassword(): string | null {
      return backend.get(this.key()) ?? null;
    }
    setPassword(value: string): void {
      backend.set(this.key(), value);
    }
    deletePassword(): boolean {
      return backend.delete(this.key());
    }
  }
  return { Entry };
});

describe('KeyringSecretStore (mocked keychain)', () => {
  beforeEach(() => backend.clear());

  it('stores values under service auto-wp and the ref name as account', async () => {
    const store = new KeyringSecretStore();
    await store.set('secret:blog-key', 'v1');
    expect(backend.get('auto-wp\u0000blog-key')).toBe('v1');
    expect(await store.get('secret:blog-key')).toBe('v1');
  });

  it('honours a custom service name', async () => {
    const store = new KeyringSecretStore({ service: 'other' });
    await store.set('secret:a', 'x');
    expect(backend.get('other\u0000a')).toBe('x');
  });

  it('reports a missing secret without echoing anything sensitive', async () => {
    const store = new KeyringSecretStore();
    await expect(store.get('secret:nope')).rejects.toThrow(
      new SecretStoreError('secret not found: secret:nope'),
    );
  });

  it('delete removes the value and is a no-op when absent', async () => {
    const store = new KeyringSecretStore();
    await store.set('secret:a', 'x');
    await store.delete('secret:a');
    expect(backend.has('auto-wp\u0000a')).toBe(false);
    await expect(store.delete('secret:a')).resolves.toBeUndefined();
  });

  it('rejects invalid refs before touching the keychain', async () => {
    const store = new KeyringSecretStore();
    await expect(store.get('plain-name')).rejects.toThrow(/invalid secret ref/);
    await expect(store.set('secret:../escape', 'x')).rejects.toThrow(SecretStoreError);
    expect(backend.size).toBe(0);
  });
});

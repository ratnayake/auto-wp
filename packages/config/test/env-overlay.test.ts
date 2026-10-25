import { InMemorySecretStore } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { EnvOverlaySecretStore, secretEnvVar } from '../src/index.js';

describe('EnvOverlaySecretStore', () => {
  it('maps refs to AUTOWP_SECRET_<NAME>', () => {
    expect(secretEnvVar('secret:site-agent-signing-key')).toBe('AUTOWP_SECRET_SITE_AGENT_SIGNING_KEY');
    expect(secretEnvVar('secret:a.b/c')).toBe('AUTOWP_SECRET_A_B_C');
  });

  it('prefers the env, falls back to the inner store lazily', async () => {
    let created = 0;
    const inner = new InMemorySecretStore({ 'secret:other': 'from-store' });
    const s = new EnvOverlaySecretStore(
      () => {
        created++;
        return inner;
      },
      { AUTOWP_SECRET_KEY1: 'from-env', AUTOWP_SECRET_EMPTY: '' },
    );
    expect(await s.get('secret:key1')).toBe('from-env');
    expect(created).toBe(0);
    expect(await s.get('secret:other')).toBe('from-store');
    await expect(s.get('secret:empty')).rejects.toThrow(/not found/);
    await s.set('secret:new', 'v');
    expect(inner.values.get('secret:new')).toBe('v');
    expect(created).toBe(1);
  });
});

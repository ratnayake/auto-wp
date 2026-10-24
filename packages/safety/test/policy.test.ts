import { PolicySchema } from '@auto-wp/contracts';
import { FakeClock } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/index.js';

const engine = (p: object = {}) => new PolicyEngine(PolicySchema.parse(p));

describe('PolicyEngine', () => {
  it('requiresApproval / isHeld', () => {
    const e = engine({ holds: ['plugin:foo'] });
    expect(e.requiresApproval('restore.execute')).toBe(true);
    expect(e.requiresApproval('update.apply')).toBe(false);
    expect(e.isHeld('plugin:foo')).toBe(true);
    expect(e.isHeld('plugin:bar')).toBe(false);
  });

  it('snapshot matrix', () => {
    const plugin = { type: 'plugin', slug: 'x' } as const;
    expect(engine({ dbSnapshot: 'always' }).needsDbSnapshot(plugin, 99999)).toBe(true);
    expect(engine({ dbSnapshot: 'never' }).needsDbSnapshot({ type: 'core', slug: 'wordpress' }, 1)).toBe(
      false,
    );
    const auto = engine();
    expect(auto.needsDbSnapshot({ type: 'core', slug: 'wordpress' }, 9999)).toBe(true);
    expect(auto.needsDbSnapshot({ type: 'plugin', slug: 'woocommerce' }, 9999)).toBe(true);
    expect(auto.needsDbSnapshot(plugin, 199)).toBe(true);
    expect(auto.needsDbSnapshot(plugin, 200)).toBe(false);
    expect(auto.needsDbSnapshot({ type: 'theme', slug: 'x' }, 5000)).toBe(false);
  });

  it('backupFreshEnough', () => {
    const clock = new FakeClock('2026-01-01T12:00:00Z');
    const e = engine({ backupMaxAgeMinutes: 60 });
    expect(e.backupFreshEnough('2026-01-01T11:00:00Z', clock.now())).toBe(true);
    expect(e.backupFreshEnough('2026-01-01T10:59:59Z', clock.now())).toBe(false);
    expect(e.backupFreshEnough('garbage', clock.now())).toBe(false);
  });
});

import { itemKey, type Policy, PolicySchema, type UpdateItem } from '@auto-wp/contracts';
import { DEFAULT_FAKE_CAPS, MemoryLogger } from '@auto-wp/contracts/fakes';
import { describe, expect, it } from 'vitest';
import { DefaultInventoryService } from '../src/index.js';
import { buildItem, type InventoryItem } from '../src/item.js';

const caps = { ...DEFAULT_FAKE_CAPS, phpVersion: '8.2.0' };
const policy = (over: Partial<Policy> = {}): Policy => PolicySchema.parse(over);
const planner = new DefaultInventoryService(new MemoryLogger());
const plan = (items: InventoryItem[], p: Policy = policy(), installed?: string) =>
  planner.plan(items, caps, p, installed);

type Over = Partial<InventoryItem>;
const plugin = (slug: string, over: Over = {}): InventoryItem =>
  buildItem({
    type: 'plugin',
    slug,
    name: slug,
    currentVersion: '1.0.0',
    newVersion: '1.0.1',
    active: true,
    source: 'wporg',
    requiresPlugins: [],
    ...over,
  });
const theme = (slug: string, over: Over = {}): InventoryItem =>
  buildItem({
    type: 'theme',
    slug,
    name: slug,
    currentVersion: '1.0.0',
    newVersion: '1.0.1',
    active: true,
    source: 'wporg',
    ...over,
  });
const core = (from: string, to: string, over: Over = {}): InventoryItem =>
  buildItem({
    type: 'core',
    slug: 'wordpress',
    name: 'WordPress',
    currentVersion: from,
    newVersion: to,
    active: true,
    source: 'wporg',
    ...over,
  });

const keys = (items: UpdateItem[]) => items.map(itemKey);

/** Deterministic permutations so property checks are reproducible. */
function permutations<T>(xs: T[], count: number): T[][] {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return Array.from({ length: count }, () => {
    const copy = [...xs];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  });
}

describe('core ordering', () => {
  it('applies a core minor update before plugins and themes', () => {
    const out = plan([theme('t'), plugin('p'), core('6.6.1', '6.6.2')]);
    expect(keys(out)).toEqual(['core:wordpress', 'plugin:p', 'theme:t']);
  });

  it('applies a core major update after plugins and themes', () => {
    const out = plan([core('6.6.2', '6.7'), theme('t'), plugin('p')]);
    expect(keys(out)).toEqual(['plugin:p', 'theme:t', 'core:wordpress']);
  });
});

describe('theme ordering', () => {
  it('places the parent before its child regardless of input order', () => {
    const child = theme('child', { parentTheme: 'parent' });
    const parent = theme('parent');
    expect(keys(plan([child, parent]))).toEqual(['theme:parent', 'theme:child']);
    expect(keys(plan([parent, child]))).toEqual(['theme:parent', 'theme:child']);
  });
});

describe('plugin ordering', () => {
  it('puts required plugins first, even when they are inactive', () => {
    const addon = plugin('addon', { requiresPlugins: ['base-lib'] });
    const base = plugin('base-lib', { active: false });
    expect(keys(plan([addon, base]))).toEqual(['plugin:base-lib', 'plugin:addon']);
  });

  it('orders active plugins before inactive ones, then alphabetically', () => {
    const out = plan([
      plugin('zeta', { active: false }),
      plugin('beta'),
      plugin('alpha'),
      plugin('omega', { active: false }),
    ]);
    expect(keys(out)).toEqual(['plugin:alpha', 'plugin:beta', 'plugin:omega', 'plugin:zeta']);
  });

  it('drops inactive plugins and themes when updateInactive is false', () => {
    const out = plan(
      [plugin('live'), plugin('dormant', { active: false }), theme('idle', { active: false })],
      policy({ updateInactive: false }),
    );
    expect(keys(out)).toEqual(['plugin:live']);
  });

  it('holds dependency cycles instead of looping', () => {
    const a = plugin('a', { requiresPlugins: ['b'] });
    const b = plugin('b', { requiresPlugins: ['a'] });
    const c = plugin('c');
    const out = plan([a, b, c]);
    expect(keys(out.filter((i) => !i.heldReason))).toEqual(['plugin:c']);
    expect(out.filter((i) => i.heldReason).map((i) => i.heldReason)).toEqual([
      'dependency cycle',
      'dependency cycle',
    ]);
  });
});

describe('holds', () => {
  it('holds items needing a newer PHP than the site runs, and keeps them in the output', () => {
    const out = plan([plugin('modern', { requiresPhp: '8.3' }), plugin('old', { requiresPhp: '7.4' })]);
    expect(keys(out)).toEqual(['plugin:old', 'plugin:modern']);
    expect(out[1]?.heldReason).toContain('8.3');
    expect(out[0]).not.toHaveProperty('heldReason');
  });

  it('holds items whose requiresWp is above the target core', () => {
    const out = plan([core('6.6.2', '6.7'), plugin('needs-68', { requiresWp: '6.8' })]);
    expect(keys(out)).toEqual(['core:wordpress', 'plugin:needs-68']);
    expect(out[1]?.heldReason).toContain('6.8');
  });

  it('honours policy.holds by itemKey', () => {
    const out = plan([plugin('pinned'), plugin('free')], policy({ holds: ['plugin:pinned'] }));
    expect(keys(out)).toEqual(['plugin:free', 'plugin:pinned']);
    expect(out[1]?.heldReason).toBeDefined();
  });

  it('places items needing the new core after core major, and older requirements in the normal order', () => {
    const out = plan([
      core('6.6.2', '6.7'),
      plugin('old-req', { requiresWp: '6.5' }),
      plugin('new-req', { requiresWp: '6.7' }),
      theme('t'),
    ]);
    expect(keys(out)).toEqual(['plugin:old-req', 'theme:t', 'core:wordpress', 'plugin:new-req']);
  });

  it('allows requiresWp equal to the planned core, placed after core minor', () => {
    const out = plan([plugin('exact', { requiresWp: '6.6.2' }), core('6.6.1', '6.6.2')]);
    expect(keys(out)).toEqual(['core:wordpress', 'plugin:exact']);
    expect(out.every((i) => i.heldReason === undefined)).toBe(true);
  });

  it('holds items needing the new core when the core update itself is held', () => {
    const out = plan(
      [core('6.6.2', '6.7'), plugin('new-req', { requiresWp: '6.7' })],
      policy({ holds: ['core:wordpress'] }),
    );
    expect(out.every((i) => i.heldReason !== undefined)).toBe(true);
    expect(out.map((i) => i.type)).toEqual(['core', 'plugin']);
  });
});

describe('plan properties', () => {
  const items = [
    core('6.6.2', '6.7'),
    plugin('woocommerce', { requiresPlugins: ['action-scheduler'], active: true }),
    plugin('action-scheduler', { active: true }),
    plugin('legacy', { requiresPhp: '9.0' }),
    plugin('dormant', { active: false }),
    plugin('needs-new-core', { requiresWp: '6.7' }),
    plugin('pinned'),
    theme('parent'),
    theme('child', { parentTheme: 'parent' }),
    theme('grandchild', { parentTheme: 'child' }),
  ];
  const p = policy({ holds: ['plugin:pinned'] });

  it('is deterministic for any input order', () => {
    const expected = plan(items, p);
    for (const shuffled of permutations(items, 25)) {
      expect(plan(shuffled, p)).toEqual(expected);
    }
  });

  it('keeps every eligible item exactly once', () => {
    const out = plan(items, p);
    expect(keys(out).sort()).toEqual(keys(items).sort());
  });

  it('keeps dependencies before dependents and parents before children', () => {
    const out = keys(plan(items, p));
    expect(out.indexOf('plugin:action-scheduler')).toBeLessThan(out.indexOf('plugin:woocommerce'));
    expect(out.indexOf('theme:parent')).toBeLessThan(out.indexOf('theme:child'));
    expect(out.indexOf('theme:child')).toBeLessThan(out.indexOf('theme:grandchild'));
  });

  it('puts every held item after every runnable item', () => {
    const out = plan(items, p);
    const firstHeld = out.findIndex((i) => i.heldReason !== undefined);
    expect(firstHeld).toBeGreaterThan(-1);
    expect(out.slice(firstHeld).every((i) => i.heldReason !== undefined)).toBe(true);
  });
});

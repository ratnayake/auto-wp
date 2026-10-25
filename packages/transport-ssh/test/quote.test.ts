import { describe, expect, it } from 'vitest';
import { buildCommand, shellQuote } from '../src/quote.js';

describe('shellQuote', () => {
  it.each([
    ['plain', `'plain'`],
    ['with space', `'with space'`],
    [`it's`, `'it'\\''s'`],
    ['$(rm -rf /)', `'$(rm -rf /)'`],
    ['`id`', "'`id`'"],
    ['a\nb', `'a\nb'`],
    ['', `''`],
    ['; echo "x" && y | z', `'; echo "x" && y | z'`],
  ])('quotes %j', (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it('rejects NUL', () => {
    expect(() => shellQuote('a\0b')).toThrow();
  });
});

describe('buildCommand', () => {
  it('quotes every element', () => {
    expect(buildCommand(['ls', '-la', 'my dir', `o'brien`])).toBe(`exec 'ls' '-la' 'my dir' 'o'\\''brien'`);
  });
  it('adds cwd and env', () => {
    expect(
      buildCommand(['wp', 'core'], { cwd: '/a b', env: { WP_CLI_CACHE_DIR: '/tmp/x y', _X1: '$HOME' } }),
    ).toBe(`cd '/a b' && WP_CLI_CACHE_DIR='/tmp/x y' _X1='$HOME' exec 'wp' 'core'`);
  });
  it.each(['lower', '1BAD', 'A-B', 'A B', 'A=B', ''])('rejects env name %j', (name) => {
    expect(() => buildCommand(['x'], { env: { [name]: 'v' } })).toThrow(/invalid environment/);
  });
  it('rejects an argv[0] that exec would parse as an option', () => {
    expect(() => buildCommand(['-c', 'x'])).toThrow();
  });
  it('rejects empty argv', () => {
    expect(() => buildCommand([])).toThrow();
  });
});

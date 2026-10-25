import type { Capabilities } from '@auto-wp/contracts';
import { DEFAULT_FAKE_CAPS, FakeSiteConnection } from '@auto-wp/contracts/fakes';

export const WP_BIN = DEFAULT_FAKE_CAPS.wpCli.path ?? 'wp';

export interface WpReply {
  stdout?: string;
  exitCode?: number;
}

/** Subcommand words of a WP-CLI argv, e.g. `['theme', 'get', 'storefront']`. Flags are dropped. */
export function subcommand(argv: readonly string[]): string {
  const start = argv.indexOf('--no-color') + 1;
  return argv
    .slice(start)
    .filter((a) => !a.startsWith('--'))
    .join(' ');
}

/** A fake site whose WP-CLI calls are answered from `replies`, keyed by subcommand (e.g. `plugin list`). */
export function wpCliSite(
  replies: Record<string, WpReply>,
  caps: Partial<Capabilities> = {},
): FakeSiteConnection {
  const c = new FakeSiteConnection('site-a', 'ssh', caps);
  c.onExec(
    () => true,
    (argv) => {
      const reply = replies[subcommand(argv)];
      return {
        exitCode: reply?.exitCode ?? (reply ? 0 : 1),
        stdout: reply?.stdout ?? '',
        stderr: reply ? '' : `fake: unscripted ${subcommand(argv)}`,
        durationMs: 0,
      };
    },
  );
  return c;
}

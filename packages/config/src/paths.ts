import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Expands a leading `~` or `~/` to the home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** Explicit path, else `$AUTOWP_CONFIG`, else `~/.config/auto-wp/config.yaml`. */
export function resolveConfigPath(
  path?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = path || env.AUTOWP_CONFIG || '~/.config/auto-wp/config.yaml';
  return resolve(expandHome(raw));
}

import os from 'node:os';
import path from 'node:path';

/**
 * Expands a leading `~` or `~/` to the given home directory (defaulting to `os.homedir()`).
 */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') {
    return home;
  }
  if (p.startsWith('~/')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

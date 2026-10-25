import { posix } from 'node:path';
import { BACKUP_DIR_NAME, type Capabilities, type SiteConfig, type UpdateItem } from '@auto-wp/contracts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SLUG = /^[a-z0-9_][a-z0-9_.-]*$/i;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

/** Ids end up in remote paths and argv: reject anything that could traverse or inject options. */
export function assertSafeId(kind: string, v: string): void {
  if (!SAFE_ID.test(v) || v.includes('..')) throw new Error(`unsafe ${kind}: ${JSON.stringify(v)}`);
}

export function assertSafeItem(item: UpdateItem): void {
  if (!SAFE_SLUG.test(item.slug) || item.slug.includes('..'))
    throw new Error(`unsafe slug: ${JSON.stringify(item.slug)}`);
  for (const v of [item.currentVersion, item.newVersion])
    if (!SAFE_VERSION.test(v) || v.includes('..')) throw new Error(`unsafe version: ${JSON.stringify(v)}`);
}

/** Backup root as configured for the site: `<wpRoot>/auto-wp-backup` (relative) or above the docroot. */
export function backupRoot(site: SiteConfig, caps: Capabilities): string {
  if (site.backupLocation === 'outside' && caps.outsideDocrootDir)
    return posix.join(caps.outsideDocrootDir, BACKUP_DIR_NAME);
  return BACKUP_DIR_NAME;
}

/** Every place a backup may live (backups can be moved outside the docroot if protection fails). */
export function backupRootCandidates(site: SiteConfig, caps: Capabilities): string[] {
  const roots = [backupRoot(site, caps), BACKUP_DIR_NAME];
  if (caps.outsideDocrootDir) roots.push(posix.join(caps.outsideDocrootDir, BACKUP_DIR_NAME));
  return [...new Set(roots)];
}

export function absPath(caps: Capabilities, p: string): string {
  return posix.normalize(p.startsWith('/') ? p : posix.join(caps.wpRoot, p));
}

export function itemSnapshotBase(item: UpdateItem): string {
  return `${item.type}-${item.slug}-${item.currentVersion}`;
}

const WP_DIRS = new Set(['wp-admin', 'wp-content', 'wp-includes']);

/**
 * Where the web agent lives below wpRoot. `topLevel` is the root entry to leave alone during a file restore
 * (the agent's own directory, or the agent file itself). `nested` is set when the agent sits inside a
 * WordPress directory, where a whole-tree swap would move it away mid-restore.
 */
export function agentLocation(site: SiteConfig): { topLevel?: string; nested?: string } {
  const t = site.transport;
  const endpoint = t.kind === 'agent' ? t.endpoint : t.kind === 'sftp+agent' ? t.agent.endpoint : undefined;
  if (!endpoint) return {};
  let rel = new URL(endpoint).pathname;
  const sitePath = new URL(site.url).pathname.replace(/\/+$/, '');
  if (sitePath && rel.startsWith(`${sitePath}/`)) rel = rel.slice(sitePath.length);
  const segs = rel.split('/').filter(Boolean);
  const first = segs[0];
  if (!first) return {};
  if (segs.length === 1 || (segs.length === 2 && !WP_DIRS.has(first))) return { topLevel: first };
  return { nested: segs.join('/') };
}

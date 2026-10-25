/**
 * Standard backup layout constants and helpers.
 *
 * Archive entry paths are relative to the WordPress root (no leading `./` or `/`).
 */

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SIG_FILE = 'manifest.json.sig';
export const DB_ARTIFACT = 'db.sql.gz';
/** Archive entry paths are relative to the WordPress root (no leading `./` or `/`). */
export const FILES_ARTIFACT = 'files.tar.gz';
export const ITEM_SNAPSHOT_DIR = 'items';
export const DUMP_TERMINATOR_PREFIX = '-- Dump completed';
export const DEFAULT_BACKUP_EXCLUDES = [
  'auto-wp-backup',
  'auto-wp-agent/.data',
  'wp-content/cache',
  'wp-content/updraft',
  'wp-content/ai1wm-backups',
  'wp-content/backups-dup-lite',
  'wp-content/uploads/backup*',
  '*.log',
];

/**
 * Returns the remote directory holding artifacts for a backup run.
 */
export function backupRunDir(root: string, backupId: string): string {
  const cleanRoot = root.replace(/\/+$/, '');
  return `${cleanRoot}/auto-wp-backup/${backupId}`;
}

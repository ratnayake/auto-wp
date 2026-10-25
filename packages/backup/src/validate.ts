import type { BackupManifest } from '@auto-wp/contracts';
import { BACKUP_ID_RE } from './constants.js';
import { BackupError } from './errors.js';

const ARTIFACT_NAME_RE = /^[a-z0-9._-]+$/;
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const isSafeArtifactName = (n: string): boolean =>
  ARTIFACT_NAME_RE.test(n) && !n.includes('..') && !n.startsWith('.');

/**
 * Manifests come from the (untrusted) remote host. Everything later used as a path component is checked
 * here, and `siteId`/`backupId` must match what we expect, never what the manifest claims.
 */
export function assertTrustedManifest(
  m: BackupManifest,
  expect: { backupId?: string; siteId: string },
): void {
  if (!BACKUP_ID_RE.test(m.backupId))
    throw new BackupError(`manifest has an invalid backupId: ${m.backupId}`);
  if (expect.backupId !== undefined && m.backupId !== expect.backupId) {
    throw new BackupError(`manifest backupId ${m.backupId} does not match its folder ${expect.backupId}`);
  }
  if (!SITE_ID_RE.test(m.siteId) || m.siteId !== expect.siteId) {
    throw new BackupError(`manifest siteId ${JSON.stringify(m.siteId)} does not match site ${expect.siteId}`);
  }
  for (const a of m.artifacts) {
    if (!isSafeArtifactName(a.name))
      throw new BackupError(`manifest has an unsafe artifact name: ${JSON.stringify(a.name)}`);
  }
}

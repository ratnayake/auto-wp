import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { BackupManifest, SiteConnection } from '@auto-wp/contracts';
import { BACKUP_ID_RE, MANIFEST_FILE, SIG_FILE } from './constants.js';
import { HashMismatchError } from './errors.js';

export const localSiteDir = (dataDir: string, siteId: string): string => join(dataDir, 'backups', siteId);

/** Newest-first ids to keep: the newest `keep`, plus `protect` if it would otherwise fall out. */
export function selectPrune(ids: readonly string[], keep: number, protect?: string): string[] {
  const sorted = [...ids].sort().reverse();
  const kept = new Set(sorted.slice(0, keep));
  if (protect) kept.add(protect);
  return sorted.filter((i) => !kept.has(i));
}

async function streamToFile(
  conn: SiteConnection,
  remote: string,
  local: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const fh = await open(local, 'w', 0o600);
  try {
    const stream = await conn.download(remote);
    for await (const chunk of stream) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      bytes += buf.length;
      await fh.write(buf);
    }
  } finally {
    await fh.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Download and re-hash every artifact into `<dataDir>/backups/<siteId>/<id>`; atomic via a .partial dir. */
export async function pullBackup(
  conn: SiteConnection,
  dataDir: string,
  remoteDir: string,
  m: BackupManifest,
): Promise<string> {
  const final = join(localSiteDir(dataDir, m.siteId), m.backupId);
  const tmp = `${final}.partial`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  try {
    for (const a of m.artifacts) {
      const got = await streamToFile(conn, posix.join(remoteDir, a.name), join(tmp, a.name));
      if (got.sha256 !== a.sha256 || got.bytes !== a.bytes) {
        throw new HashMismatchError(
          `${a.name}: downloaded sha256/size does not match manifest (expected ${a.sha256}/${a.bytes}, got ${got.sha256}/${got.bytes})`,
        );
      }
    }
    for (const name of [MANIFEST_FILE, SIG_FILE]) {
      const remote = posix.join(remoteDir, name);
      if (name === SIG_FILE && !(await conn.stat(remote))) continue;
      await streamToFile(conn, remote, join(tmp, name));
    }
    await rm(final, { recursive: true, force: true });
    await rename(tmp, final);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return final;
}

export async function listLocalIds(dataDir: string, siteId: string): Promise<string[]> {
  try {
    const names = await readdir(localSiteDir(dataDir, siteId));
    return names.filter((n) => BACKUP_ID_RE.test(n));
  } catch {
    return [];
  }
}

export async function removeLocal(dataDir: string, siteId: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) await rm(join(localSiteDir(dataDir, siteId), id), { recursive: true, force: true });
}

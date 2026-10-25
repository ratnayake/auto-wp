import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type BackupManifest, BackupManifestSchema, type SiteConnection } from '@auto-wp/contracts';
import { BACKUP_ID_RE, MANIFEST_FILE, SIG_FILE } from './constants.js';
import { BackupError, HashMismatchError } from './errors.js';
import { assertTrustedManifest } from './validate.js';

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
  o: { siteId: string; verifyManifest?: (bytes: Buffer, sig: Buffer) => Promise<boolean> },
): Promise<string> {
  assertTrustedManifest(m, { siteId: o.siteId });
  const siteDir = resolve(localSiteDir(dataDir, o.siteId));
  const final = resolve(siteDir, m.backupId);
  if (!final.startsWith(siteDir + sep))
    throw new BackupError('refusing to write outside the backup directory');
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
    // the stored manifest must be the one whose hashes we just verified
    const stored = await readFile(join(tmp, MANIFEST_FILE));
    if (!isDeepStrictEqual(BackupManifestSchema.parse(JSON.parse(stored.toString())), m)) {
      throw new BackupError('manifest.json changed on the server while it was being pulled');
    }
    if (o.verifyManifest) {
      let sig: Buffer;
      try {
        sig = Buffer.from((await readFile(join(tmp, SIG_FILE))).toString().trim(), 'base64');
      } catch {
        throw new BackupError('manifest signature missing');
      }
      if (!(await o.verifyManifest(stored, sig))) throw new BackupError('manifest signature is invalid');
    }
    // swap in place without ever leaving the site without a good copy
    const old = `${final}.old`;
    await rm(old, { recursive: true, force: true });
    const hadOld = await rename(final, old).then(
      () => true,
      () => false,
    );
    try {
      await rename(tmp, final);
    } catch (e) {
      if (hadOld) await rename(old, final).catch(() => {});
      throw e;
    }
    await rm(old, { recursive: true, force: true });
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

import { randomBytes } from 'node:crypto';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Writes via a temp file in the same directory, fsyncs, then renames over the target.
 * A symlink is followed so the link itself survives and its target is replaced.
 */
export async function atomicWriteFile(linkOrPath: string, data: string, mode = 0o600): Promise<void> {
  const path = await realpath(linkOrPath).catch(() => linkOrPath);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmp, 'wx', mode);
    await fh.chmod(mode); // the umask may have removed bits from `mode`
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, path);
  } catch (err) {
    await fh?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  // Best effort: make the rename durable. Not supported on every platform.
  const dirHandle = await open(dir, 'r').catch(() => undefined);
  if (dirHandle) {
    await dirHandle.sync().catch(() => undefined);
    await dirHandle.close();
  }
}

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Logger } from '@auto-wp/contracts';
import type { DockerRunner } from './docker.js';

export interface DeepRestoreOptions {
  runner: DockerRunner;
  image: string;
  /** Opens the decompressed SQL dump. */
  openDump(): Readable;
  tables: readonly string[];
  logger: Logger;
  sleep(ms: number): Promise<void>;
  readyTimeoutMs?: number;
  importTimeoutMs?: number;
}

export type DeepRestoreOutcome =
  | { ok: true; counts: Map<string, number> }
  | { ok: false; stage: string; error: string };

const quoteIdent = (n: string): string => `\`${n.replaceAll('`', '``')}\``;
const trimErr = (s: string): string => s.trim().slice(0, 500);

/** Import the dump into a throwaway MariaDB container and count rows per table. */
export async function deepRestore(o: DeepRestoreOptions): Promise<DeepRestoreOutcome> {
  const name = `auto-wp-verify-${randomBytes(4).toString('hex')}`;
  const { runner } = o;
  let started = false;
  try {
    const run = await runner.run(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-e',
        'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1',
        '-e',
        'MARIADB_DATABASE=verify',
        o.image,
      ],
      { timeoutMs: 300_000 },
    );
    if (run.exitCode !== 0) return { ok: false, stage: 'start', error: trimErr(run.stderr) };
    started = true;

    const deadline = Date.now() + (o.readyTimeoutMs ?? 120_000);
    let ready = false;
    while (Date.now() < deadline) {
      // TCP: the init-phase server only listens on the socket, the final server on 127.0.0.1 too.
      const ping = await runner.run(['exec', name, 'mariadb', '-uroot', '-h127.0.0.1', '-e', 'SELECT 1'], {
        timeoutMs: 10_000,
      });
      if (ping.exitCode === 0) {
        ready = true;
        break;
      }
      await o.sleep(1000);
    }
    if (!ready) return { ok: false, stage: 'ready', error: 'database did not become ready in time' };

    const imp = await runner.run(['exec', '-i', name, 'mariadb', '-uroot', '--database=verify'], {
      stdin: o.openDump(),
      timeoutMs: o.importTimeoutMs ?? 900_000,
    });
    if (imp.exitCode !== 0) return { ok: false, stage: 'import', error: trimErr(imp.stderr) };

    const counts = new Map<string, number>();
    for (let i = 0; i < o.tables.length; i += 40) {
      const batch = o.tables.slice(i, i + 40);
      const sql = batch
        .map((t) => `SELECT ${quoteLiteral(t)}, COUNT(*) FROM ${quoteIdent(t)}`)
        .join(' UNION ALL ');
      const q = await runner.run(
        ['exec', name, 'mariadb', '-uroot', '--database=verify', '-N', '-B', '-e', sql],
        { timeoutMs: 120_000 },
      );
      if (q.exitCode !== 0) return { ok: false, stage: 'count', error: trimErr(q.stderr) };
      for (const line of q.stdout.split('\n')) {
        const tab = line.lastIndexOf('\t');
        if (tab > 0) counts.set(line.slice(0, tab), Number(line.slice(tab + 1)));
      }
    }
    return { ok: true, counts };
  } catch (e) {
    return { ok: false, stage: 'error', error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (started) {
      await runner.run(['rm', '-f', name], { timeoutMs: 60_000 }).catch((e) => {
        o.logger.warn({ err: String(e), container: name }, 'failed to remove verify container');
      });
    }
  }
}

function quoteLiteral(s: string): string {
  return `'${s.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

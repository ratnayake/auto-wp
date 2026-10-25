import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '@auto-wp/config';
import { type Logger, type RunRecord, RunRecordSchema, type RunStore } from '@auto-wp/contracts';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Durable RunStore: one JSON file per run under `<stateDir>/runs/<runId>.json`, written atomically (0600).
 * Writes are serialised per store so concurrent saves of the same run cannot interleave.
 */
export class FileRunStore implements RunStore {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    stateDir: string,
    private readonly logger?: Logger,
  ) {
    this.dir = join(stateDir, 'runs');
  }

  private path(runId: string): string {
    if (!SAFE_RUN_ID.test(runId) || runId.includes('..')) throw new Error(`unsafe runId: ${runId}`);
    return join(this.dir, `${runId}.json`);
  }

  save(r: RunRecord): Promise<void> {
    let path: string;
    let data: string;
    try {
      path = this.path(r.runId);
      data = `${JSON.stringify(RunRecordSchema.parse(r), null, 2)}\n`;
    } catch (err) {
      return Promise.reject(err);
    }
    const run = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await atomicWriteFile(path, data, 0o600);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    if (!SAFE_RUN_ID.test(runId) || runId.includes('..')) return undefined;
    await this.queue;
    return this.read(this.path(runId));
  }

  async list(siteId?: string): Promise<RunRecord[]> {
    await this.queue;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: RunRecord[] = [];
    for (const n of names.filter((x) => x.endsWith('.json') && !x.startsWith('.')).sort()) {
      const r = await this.read(join(this.dir, n));
      if (r && (!siteId || r.siteId === siteId)) out.push(r);
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private async read(path: string): Promise<RunRecord | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = RunRecordSchema.safeParse(json);
    if (!parsed.success) {
      this.logger?.warn({ path }, 'ignoring unreadable run record');
      return undefined;
    }
    return parsed.data;
  }
}

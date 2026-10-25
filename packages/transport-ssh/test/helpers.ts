import { EventEmitter } from 'node:events';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { MemoryLogger } from '@auto-wp/contracts/fakes';
import type { Client } from 'ssh2';
import { type SshConnectionDeps, SshSiteConnection, type SshTransportConfig } from '../src/index.js';

export const HOST_KEY = Buffer.from('fake-host-key');

export const baseConfig: SshTransportConfig = {
  kind: 'ssh',
  host: 'example.test',
  port: 22,
  username: 'u',
  hostKeySha256: '',
  wpRoot: '/home/u/public_html',
  phpBinary: 'php',
  toolDir: '~/.auto-wp',
};

type SftpErr = Error & { code: number };
const noFile = (p: string): SftpErr => Object.assign(new Error(`No such file: ${p}`), { code: 2 });

/** In-memory SFTP server with symlink support, using the same callback API as ssh2's SFTPWrapper. */
export class FakeSftp {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(['/', '/home', '/home/u']);
  links = new Map<string, string>();
  modes = new Map<string, number>();
  home = '/home/u';
  ended = false;
  /** Set to disable the OpenSSH rename extension (it is absent by default). */
  ext_openssh_rename?: unknown;

  mkdirs(p: string) {
    for (let cur = p; cur !== '/'; cur = posix.dirname(cur)) this.dirs.add(cur);
  }

  private resolve(p: string, followLast = true, depth = 0): string {
    if (depth > 20) throw new Error('too many links');
    if (p === '.') return this.home;
    const parts = posix.normalize(p).split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur = `${cur}/${parts[i]}`;
      const target = this.links.get(cur);
      if (target && (i < parts.length - 1 || followLast)) {
        const abs = posix.resolve(posix.dirname(cur), target);
        cur = this.resolve(abs, true, depth + 1);
      }
    }
    return cur || '/';
  }
  private attrs(p: string) {
    if (this.links.has(p)) return { mode: 0o120777, size: 0, mtime: 1 };
    const f = this.files.get(p);
    if (f) return { mode: 0o100000 | (this.modes.get(p) ?? 0o644), size: f.length, mtime: 1 };
    if (this.dirs.has(p)) return { mode: 0o040000 | (this.modes.get(p) ?? 0o755), size: 0, mtime: 1 };
    return undefined;
  }

  realpath = (p: string, cb: (e: Error | null, v?: string) => void) => {
    const r = this.resolve(p);
    return this.attrs(r) ? cb(null, r) : cb(noFile(p));
  };
  lstat = (p: string, cb: (e: Error | null, v?: unknown) => void) => {
    const a = this.attrs(this.resolve(p, false));
    cb(a ? null : noFile(p), a);
  };
  stat = (p: string, cb: (e: Error | null, v?: unknown) => void) => {
    const a = this.attrs(this.resolve(p));
    cb(a ? null : noFile(p), a);
  };
  readdir = (p: string, cb: (e: Error | null, v?: unknown) => void) => {
    const d = this.resolve(p);
    if (!this.dirs.has(d)) return cb(noFile(p));
    const names = new Set<string>();
    for (const k of [...this.files.keys(), ...this.dirs, ...this.links.keys()]) {
      if (k !== d && posix.dirname(k) === d) names.add(posix.basename(k));
    }
    cb(
      null,
      [...names].map((filename) => ({ filename, attrs: this.attrs(posix.join(d, filename)) })),
    );
  };
  mkdir = (p: string, _o: unknown, cb: (e?: Error) => void) => {
    if (!this.dirs.has(posix.dirname(p))) return cb(noFile(p));
    this.dirs.add(p);
    cb();
  };
  rmdir = (p: string, cb: (e?: Error) => void) => {
    this.dirs.delete(p);
    cb();
  };
  unlink = (p: string, cb: (e?: Error) => void) => {
    const had = this.files.delete(p) || this.links.delete(p);
    cb(had ? undefined : noFile(p));
  };
  chmod = (p: string, mode: number, cb: (e?: Error) => void) => {
    this.modes.set(p, mode);
    cb();
  };
  readFile = (p: string, cb: (e: Error | null, v?: Buffer) => void) => {
    const f = this.files.get(this.resolve(p));
    cb(f ? null : noFile(p), f);
  };
  writeFile = (p: string, data: Buffer, o: { mode?: number }, cb: (e?: Error) => void) => {
    this.files.set(p, Buffer.from(data));
    if (o.mode !== undefined) this.modes.set(p, o.mode);
    cb();
  };
  rename = (a: string, b: string, cb: (e?: Error) => void) => {
    const f = this.files.get(a);
    if (!f) return cb(noFile(a));
    if (this.files.has(b)) return cb(new Error('failure'));
    this.files.delete(a);
    this.files.set(b, f);
    const m = this.modes.get(a);
    if (m !== undefined) this.modes.set(b, m);
    cb();
  };
  createReadStream = (p: string, o: { start?: number }) =>
    Readable.from([(this.files.get(p) ?? Buffer.alloc(0)).subarray(o.start ?? 0)]);
  end = () => {
    this.ended = true;
  };
}

export interface ExecReply {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Never close by itself (for timeout tests). */
  hang?: boolean;
}
export type ExecHandler = (command: string, stdin: Buffer) => ExecReply | Promise<ExecReply>;

export class FakeStream extends EventEmitter {
  stderr = new EventEmitter();
  closedByClient = false;
  stdin: Buffer[] = [];
  constructor(private readonly onEnd: (stdin: Buffer) => void) {
    super();
  }
  end(data?: Buffer | string) {
    if (data !== undefined) this.stdin.push(Buffer.from(data));
    this.onEnd(Buffer.concat(this.stdin));
  }
  signals: string[] = [];
  signal(name: string) {
    this.signals.push(name);
  }
  close() {
    this.closedByClient = true;
    this.emit('close', null, 'KILL');
  }
}

export class FakeClient extends EventEmitter {
  commands: string[] = [];
  streams: FakeStream[] = [];
  connectOpts?: Record<string, unknown>;
  ended = false;
  execHandler: ExecHandler = () => ({ stdout: '' });
  constructor(
    readonly sftpServer: FakeSftp,
    private readonly presentedKey: Buffer = HOST_KEY,
  ) {
    super();
  }
  connect(opts: Record<string, unknown>) {
    this.connectOpts = opts;
    queueMicrotask(() => {
      const verifier = opts.hostVerifier as (k: Buffer) => boolean;
      if (!verifier(this.presentedKey))
        return this.emit('error', new Error('Handshake failed: host key rejected'));
      this.emit('ready');
    });
    return this;
  }
  exec(command: string, cb: (e: Error | undefined, s: FakeStream) => void) {
    this.commands.push(command);
    const stream = new FakeStream(async (stdin) => {
      if (command.startsWith('echo "AUTOWP_PID=$$" >&2; '))
        stream.stderr.emit('data', Buffer.from('AUTOWP_PID=4242\n'));
      const r = await this.execHandler(command, stdin);
      if (r.hang) return;
      if (r.stdout) stream.emit('data', Buffer.from(r.stdout));
      if (r.stderr) stream.stderr.emit('data', Buffer.from(r.stderr));
      stream.emit('close', r.code ?? 0);
    });
    this.streams.push(stream);
    cb(undefined, stream);
  }
  sftp(cb: (e: Error | undefined, s: FakeSftp) => void) {
    cb(undefined, this.sftpServer);
  }
  end() {
    this.ended = true;
  }
}

export interface Harness {
  conn: SshSiteConnection;
  client: FakeClient;
  sftp: FakeSftp;
  logger: MemoryLogger;
  sleeps: number[];
}

export async function fingerprint(key: Buffer): Promise<string> {
  const { fingerprintOf } = await import('../src/index.js');
  return fingerprintOf(key);
}

export async function makeHarness(
  o: {
    config?: Partial<SshTransportConfig>;
    agentSource?: Buffer;
    presentedKey?: Buffer;
    deps?: Partial<SshConnectionDeps>;
  } = {},
): Promise<Harness> {
  const sftp = new FakeSftp();
  sftp.mkdirs('/home/u/public_html');
  const client = new FakeClient(sftp, o.presentedKey);
  const logger = new MemoryLogger();
  const sleeps: number[] = [];
  const conn = new SshSiteConnection(
    'site',
    { ...baseConfig, hostKeySha256: await fingerprint(HOST_KEY), ...o.config },
    {
      logger,
      agentPhpSource: async () => o.agentSource ?? Buffer.from('<?php // agent'),
      sshAgentSocket: '/tmp/agent.sock',
      // never hit the network from unit tests; tests that exercise the bootstrap pass their own fetcher
      fetcher: async () => {
        throw new Error('offline');
      },
      createClient: () => client as unknown as Client,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...o.deps,
    },
  );
  return { conn, client, sftp, logger, sleeps };
}

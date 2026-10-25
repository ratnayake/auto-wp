import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunOptions {
  /** Piped to the process' stdin. */
  stdin?: Readable;
  timeoutMs?: number;
}

/** Runs `docker <args>`. Injectable so the deep drill can be unit tested without Docker. */
export interface DockerRunner {
  run(args: readonly string[], o?: DockerRunOptions): Promise<DockerRunResult>;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

export class CliDockerRunner implements DockerRunner {
  constructor(private readonly bin = 'docker') {}

  run(args: readonly string[], o: DockerRunOptions = {}): Promise<DockerRunResult> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let failure = '';
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8');
      });
      const timer = o.timeoutMs
        ? setTimeout(() => {
            failure = `timed out after ${o.timeoutMs}ms`;
            child.kill('SIGKILL');
          }, o.timeoutMs)
        : undefined;
      child.stdin.on('error', () => {});
      if (o.stdin) {
        o.stdin.on('error', (e) => {
          failure = `stdin failed: ${e.message}`;
          child.kill('SIGKILL');
        });
        o.stdin.pipe(child.stdin);
      } else child.stdin.end();
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: 127, stdout, stderr: `${stderr}${e.message}` });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          exitCode: failure ? -1 : (code ?? -1),
          stdout,
          stderr: failure ? `${stderr}\n${failure}` : stderr,
        });
      });
    });
  }
}

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

export interface SshFixture {
  host: string;
  port: number;
  username: string;
  hostKeySha256: string;
  agentSocket: string;
  wpRoot: string;
  agentPhpPath: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    sshFixture: SshFixture | null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const IMAGE = 'auto-wp-ssh-it:1';

function sh(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dockerAvailable(): boolean {
  try {
    sh('docker', ['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

export default async function setup(project: TestProject) {
  const cleanup: Array<() => void> = [];
  const teardown = () => {
    for (const fn of cleanup.reverse()) {
      try {
        fn();
      } catch {
        // best effort
      }
    }
  };
  if (process.env.AUTO_WP_SKIP_DOCKER || !dockerAvailable()) {
    project.provide('sshFixture', null);
    return teardown;
  }
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'auto-wp-ssh-it-'));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));

    sh('docker', ['build', '-q', '-t', IMAGE, join(here, 'fixtures')]);

    // Throwaway ed25519 key, held only by a private ssh-agent (no key file is ever read by the transport).
    const key = join(tmp, 'id_ed25519');
    sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const sock = join(tmp, 'agent.sock');
    const agent: ChildProcess = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
    cleanup.push(() => agent.kill());
    for (let i = 0; i < 50 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    sh('ssh-add', [key], { ...process.env, SSH_AUTH_SOCK: sock });

    const name = `auto-wp-ssh-it-${process.pid}`;
    const pub = readFileSync(`${key}.pub`, 'utf8').trim();
    sh('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      `AUTHORIZED_KEY=${pub}`,
      '-p',
      '127.0.0.1::22',
      IMAGE,
    ]);
    cleanup.push(() => sh('docker', ['rm', '-f', name]));

    const portLine = sh('docker', ['port', name, '22/tcp']).trim().split('\n')[0] ?? '';
    const port = Number(portLine.split(':').pop());
    const fp = sh('docker', ['exec', name, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub'])
      .trim()
      .split(/\s+/)[1];
    if (!port || !fp?.startsWith('SHA256:')) throw new Error(`bad container info: port=${port} fp=${fp}`);

    // wait for sshd
    for (let i = 0; i < 60; i++) {
      try {
        sh('docker', ['exec', name, 'sh', '-c', 'pgrep sshd >/dev/null']);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    project.provide('sshFixture', {
      host: '127.0.0.1',
      port,
      username: 'tester',
      hostKeySha256: fp,
      agentSocket: sock,
      wpRoot: '/home/tester/wp',
      agentPhpPath: join(here, 'fixtures', 'stub-agent.php'),
    });
  } catch (e) {
    console.error('[transport-ssh] docker fixture unavailable, integration tests will be skipped:', e);
    teardown();
    cleanup.length = 0;
    project.provide('sshFixture', null);
  }
  return teardown;
}

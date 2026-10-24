import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(E2E_DIR, '.tmp', 'env');

/** Load e2e/.tmp/env (written by up.sh) into process.env when e2e is enabled. */
export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env.AUTOWP_E2E !== '1' || !existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  for (const [k, v] of Object.entries(out)) process.env[k] ??= v;
  return out;
}
const fileEnv = loadEnv();

/** Everything is skipped unless AUTOWP_E2E=1, so plain `pnpm test` never touches Docker. */
export const ENABLED = process.env.AUTOWP_E2E === '1';
/** Scenarios that need the real services wired into the MCP server (it runs FAKE services until integration). */
export const REAL = ENABLED && process.env.AUTOWP_E2E_REAL === '1';
export const AGENT = ENABLED && process.env.AUTOWP_E2E_AGENT === '1';
export const mcpEnv = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  ...fileEnv,
});

const port = (name: string, dflt: string) => process.env[name] ?? dflt;
export const ports = {
  sshHttp: port('AUTOWP_E2E_PORT_SSH_HTTP', '8080'),
  lockedHttp: port('AUTOWP_E2E_PORT_LOCKED_HTTP', '8081'),
  feeds: port('AUTOWP_E2E_PORT_FEEDS', '8090'),
  ssh: port('AUTOWP_E2E_PORT_SSH', '2222'),
};

export const SSH_CONTAINER = 'autowp-e2e-wp-ssh-1';
export const LOCKED_CONTAINER = 'autowp-e2e-wp-locked-1';
export const DB_CONTAINER = 'autowp-e2e-db-1';

export interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], input?: string): Result {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout: 300_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `docker exec` as cpuser (wp-ssh) or the default user (others). */
export function dexec(container: string, cmd: string, user?: string): Result {
  const u = user ? ['-u', user] : [];
  return run('docker', ['exec', ...u, container, 'bash', '-c', cmd]);
}

export const wp = (args: string): Result => dexec(SSH_CONTAINER, `wp --path=/var/www/html ${args}`, 'cpuser');

export function mustOk(r: Result): string {
  if (r.status !== 0) throw new Error(`command failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function ssh(extra: string[], remoteCmd: string, knownHosts: string, strict = 'yes'): Result {
  return run('ssh', [
    '-i',
    process.env.AUTOWP_E2E_KEY ?? join(E2E_DIR, '.tmp', 'id_ed25519'),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    `StrictHostKeyChecking=${strict}`,
    '-o',
    'ConnectTimeout=10',
    '-p',
    ports.ssh,
    ...extra,
    'cpuser@localhost',
    remoteCmd,
  ]);
}

/** curl rather than fetch: a PHP fatal can drop the connection mid-body, which makes fetch throw. */
export async function http(url: string): Promise<{ status: number; text: string }> {
  const r = run('curl', ['-s', '--max-time', '60', '-w', '\n%{http_code}', url]);
  const i = r.stdout.lastIndexOf('\n');
  return { status: Number(r.stdout.slice(i + 1)), text: r.stdout.slice(0, i) };
}

export function sha(container: string, dir: string): string {
  return mustOk(
    dexec(container, `cd ${dir} && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`),
  );
}

export { execFileSync };

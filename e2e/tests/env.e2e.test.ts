import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DB_CONTAINER,
  dexec,
  E2E_DIR,
  ENABLED,
  http,
  LOCKED_CONTAINER,
  mustOk,
  ports,
  run,
  SSH_CONTAINER,
  ssh,
  wp,
} from './helpers.js';

const knownHosts = process.env.AUTOWP_E2E_KNOWN_HOSTS ?? join(E2E_DIR, '.tmp', 'known_hosts');
const LOCKED = '/var/www/html';

describe.skipIf(!ENABLED)('e2e environment', () => {
  it('all containers are healthy', () => {
    for (const c of [DB_CONTAINER, SSH_CONTAINER, LOCKED_CONTAINER, 'autowp-e2e-mock-feeds-1']) {
      expect(mustOk(run('docker', ['inspect', '-f', '{{.State.Health.Status}}', c])), c).toBe('healthy');
    }
  });

  it('serves both sites with 200', async () => {
    expect((await http(`http://127.0.0.1:${ports.sshHttp}/`)).status).toBe(200);
    expect((await http(`http://127.0.0.1:${ports.lockedHttp}/`)).status).toBe(200);
  });

  describe('seeded versions (wp-ssh via wp-cli)', () => {
    it.each([
      ['core version', 'core version', '6.5.2'],
      ['contact-form-7', 'plugin get contact-form-7 --field=version', '5.7'],
      ['classic-editor', 'plugin get classic-editor --field=version', '1.6.3'],
      ['autowp-breaker', 'plugin get autowp-breaker --field=version', '1.0.0'],
      ['twentytwentyfour', 'theme get twentytwentyfour --field=version', '1.0'],
    ])('%s', (_n, cmd, expected) => {
      expect(mustOk(wp(cmd))).toBe(expected);
    });

    it('cf7 and the breaker are active, theme is active, sample content exists', () => {
      expect(mustOk(wp('plugin list --status=active --field=name'))).toContain('contact-form-7');
      expect(mustOk(wp('plugin list --status=active --field=name'))).toContain('autowp-breaker');
      expect(mustOk(wp('theme list --status=active --field=name'))).toBe('twentytwentyfour');
      expect(Number(mustOk(wp('post list --post_type=post --format=count')))).toBeGreaterThanOrEqual(3);
      expect(Number(mustOk(wp('post list --post_type=page --format=count')))).toBeGreaterThanOrEqual(2);
    });

    it('debug logging is on', () => {
      expect(mustOk(wp('config get WP_DEBUG'))).toBe('1');
      expect(mustOk(wp('config get WP_DEBUG_LOG'))).toBe('1');
    });
  });

  describe('seeded versions (wp-locked, file headers)', () => {
    it('core and plugins match', () => {
      const core = mustOk(dexec(LOCKED_CONTAINER, `grep "wp_version =" ${LOCKED}/wp-includes/version.php`));
      expect(core).toContain("'6.5.2'");
      const hdr = (p: string) =>
        mustOk(dexec(LOCKED_CONTAINER, `grep -m1 -E '^[ *]*Version:' ${LOCKED}/wp-content/plugins/${p}`));
      expect(hdr('autowp-breaker/autowp-breaker.php')).toContain('1.0.0');
      expect(hdr('contact-form-7/wp-contact-form-7.php')).toContain('5.7');
    });
  });

  describe('ssh', () => {
    it('key login works with a pinned host key', () => {
      const r = ssh([], 'whoami && php -v | head -1', knownHosts);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('cpuser');
    });

    it('the pinned fingerprint matches what sshd presents', () => {
      const pinned = mustOk(run('bash', ['-c', `ssh-keygen -lf ${knownHosts} | awk 'NR==1{print $2}'`]));
      expect(pinned).toMatch(/^SHA256:/);
      expect(pinned).toBe(process.env.AUTOWP_E2E_HOST_FPR);
      // compare against the key inside the container, not against our own scan
      const inContainer = mustOk(
        dexec(SSH_CONTAINER, "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'"),
      );
      expect(pinned).toBe(inContainer);
    });

    it('password authentication is refused', () => {
      const r = run('ssh', [
        '-o',
        'PubkeyAuthentication=no',
        '-o',
        'PreferredAuthentications=password,keyboard-interactive',
        '-o',
        'BatchMode=yes',
        '-o',
        `UserKnownHostsFile=${knownHosts}`,
        '-o',
        'StrictHostKeyChecking=yes',
        '-p',
        ports.ssh,
        'cpuser@localhost',
        'true',
      ]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/Permission denied/);
    });

    it('a wrong known_hosts entry is refused with StrictHostKeyChecking=yes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'autowp-kh-'));
      mustOk(run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'other')]));
      const pub = readFileSync(join(dir, 'other.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
      const bad = join(dir, 'known_hosts');
      writeFileSync(bad, `[localhost]:${ports.ssh} ${pub}\n`);
      const r = ssh([], 'true', bad);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/host key (verification failed|.*changed)|HOST IDENTIFICATION HAS CHANGED/i);
    });
  });

  describe('breaker v2 update', () => {
    it('fatals the site via wp-cli, and restoring v1 fixes it', async () => {
      const dir = '/var/www/html/wp-content/plugins';
      mustOk(dexec(SSH_CONTAINER, `tar -C ${dir} -czf /tmp/breaker-v1.tgz autowp-breaker`, 'cpuser'));
      try {
        wp('plugin update autowp-breaker');
        const ver = mustOk(
          dexec(SSH_CONTAINER, `grep -m1 -E '^[ *]*Version:' ${dir}/autowp-breaker/autowp-breaker.php`),
        );
        expect(ver).toContain('2.0.0');

        const broken = await http(`http://127.0.0.1:${ports.sshHttp}/`);
        expect(broken.status).toBe(500);
        expect(wp('option get home').status).not.toBe(0);
      } finally {
        mustOk(
          dexec(
            SSH_CONTAINER,
            `rm -rf ${dir}/autowp-breaker && tar -C ${dir} -xzf /tmp/breaker-v1.tgz`,
            'cpuser',
          ),
        );
      }
      // opcache revalidates restored files within ~2s
      let status = 0;
      for (let i = 0; i < 15 && status !== 200; i++) {
        status = (await http(`http://127.0.0.1:${ports.sshHttp}/`)).status;
        if (status !== 200) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(status).toBe(200);
      expect(mustOk(wp('plugin get autowp-breaker --field=version'))).toBe('1.0.0');
    });
  });

  describe('mock feed', () => {
    it('serves a Wordfence-v3-shaped feed with the expected CVEs', async () => {
      const res = await http(`http://127.0.0.1:${ports.feeds}/wordfence-v3.json`);
      expect(res.status).toBe(200);
      const feed = JSON.parse(res.text) as Record<
        string,
        { cve: string; software: { slug: string; type: string }[] }
      >;
      const slugs = Object.values(feed).flatMap((v) => v.software.map((s) => `${s.type}:${s.slug}`));
      expect(slugs.sort()).toEqual(['core:wordpress', 'plugin:contact-form-7', 'theme:twentytwentyfour']);
      expect(Object.values(feed).every((v) => v.cve.startsWith('CVE-'))).toBe(true);
    });

    it('serves the breaker zips, reachable from inside the WP network', () => {
      const r = dexec(
        SSH_CONTAINER,
        'curl -s -o /tmp/b.zip -w "%{http_code}" http://mock-feeds/autowp-breaker-2.0.0.zip && unzip -l /tmp/b.zip',
      );
      expect(r.stdout).toContain('200');
      expect(r.stdout).toContain('autowp-breaker/autowp-breaker.php');
    });
  });

  describe('wp-locked', () => {
    it('has exec disabled for web requests and a 30s time limit', async () => {
      const res = await http(`http://127.0.0.1:${ports.lockedHttp}/autowp-probe.php`);
      expect(res.status).toBe(200);
      const probe = JSON.parse(res.text);
      expect(probe).toMatchObject({
        exec: false,
        shell_exec: false,
        proc_open: false,
        max_execution_time: '30',
      });
      expect(probe.disable_functions).toContain('popen');
    });

    it('has no sshd and no wp-cli', () => {
      expect(dexec(LOCKED_CONTAINER, 'command -v sshd wp').status).not.toBe(0);
    });
  });
});

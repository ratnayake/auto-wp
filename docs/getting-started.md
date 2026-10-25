# Getting started with auto-wp

This guide takes you from a fresh checkout to your first real update run on a WordPress site.

## Contents

1. [What auto-wp is](#1-what-auto-wp-is)
2. [Prerequisites](#2-prerequisites)
3. [Install](#3-install)
4. [Try it locally first](#4-try-it-locally-first)
5. [Configure sites](#5-configure-sites)
6. [Connect a site](#6-connect-a-site)
7. [Run the MCP server](#7-run-the-mcp-server)
8. [First maintenance run](#8-first-maintenance-run)
9. [Restore and housekeeping](#9-restore-and-housekeeping)
10. [Vulnerability data](#10-vulnerability-data)
11. [Troubleshooting and known limitations](#11-troubleshooting-and-known-limitations)
12. [Security checklist](#12-security-checklist)

## 1. What auto-wp is

auto-wp is an MCP server that maintains WordPress sites on shared hosting. It runs outside WordPress, on a VPS or on your own machine.
- It reaches each site over SSH + WP-CLI, or through a signed standalone PHP agent when SSH is not available.
- It backs up the database and files into `<site root>/auto-wp-backup`, verifies the backup, applies core, theme and plugin updates one by one with health checks and automatic rollback, and compares the site before and after.
- It reports core, themes and updated plugins only, with old and new versions and known vulnerabilities.

Design details are in [ADR-001](ADR-001-architecture.md). The agent wire format is in [agent-protocol.md](agent-protocol.md).

## 2. Prerequisites

On the machine that runs auto-wp (VPS or local):
- Node.js 24 or newer (`engines.node` is `>=24`).
- pnpm 11 (`packageManager` is `pnpm@11.20.0`).
- Docker, for the local end-to-end harness in section 4 and on the controller for `backup_verify` with `deep=true` (the restore drill runs in a throwaway MariaDB container; without Docker the deep check is skipped with a warning).
- `ssh`, `ssh-keygen` and `ssh-keyscan` for the SSH setup.

On each WordPress site, one of:
- **SSH transport:** SSH access and PHP CLI. auto-wp uploads `agent.php` and `wp-cli.phar` into `toolDir` (default `~/.auto-wp`).
- **Agent transport:** PHP 7.4 to 8.4 served over HTTPS. No SSH is needed.

## 3. Install

```sh
git clone https://github.com/ratnayake/auto-wp.git
cd auto-wp
pnpm install
pnpm test
```

`pnpm test` runs all unit tests. It never starts Docker.

## 4. Try it locally first

The e2e harness starts two throwaway WordPress sites in Docker (one reached over SSH, one over the agent) and drives the whole flow against them. Run it before you point auto-wp at a real site.

```sh
e2e/scripts/up.sh
AUTOWP_E2E_REAL=1 AUTOWP_E2E=1 pnpm e2e
e2e/scripts/down.sh
```

The first start downloads images and WordPress and takes about 7 minutes. `down.sh` removes the containers and volumes. See [e2e/README.md](../e2e/README.md) for what the scenarios cover.

## 5. Configure sites

### Location

auto-wp reads one YAML (or JSON) file. The path is, in order:
1. `--config <file>` on the server command line,
2. the `AUTOWP_CONFIG` environment variable,
3. `~/.config/auto-wp/config.yaml`.

If you pass neither the flag nor the variable and the default file does not exist, the server starts with no sites. If you name a file that does not exist, it fails.

```sh
mkdir -p ~/.config/auto-wp
chmod 700 ~/.config/auto-wp
```

### Schema

The schema is `AppConfigSchema` in [`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts). Unknown defaults are filled in for you.

Top-level keys:

| Key                         | Default                  | Meaning                                |
| --------------------------- | ------------------------ | -------------------------------------- |
| `sites`                     | (required)               | List of sites                          |
| `policy`                    | see below                | Defaults for every site                |
| `stateDir`                  | `~/.local/state/auto-wp` | Runs and audit log                     |
| `dataDir`                   | `~/.local/share/auto-wp` | Local backups, caches, `secrets.enc`   |
| `vulndb.wordfenceApiKeyRef` | none                     | `secret:` ref to the Wordfence API key |
| `vulndb.wordfenceFeedUrl`   | none                     | Custom Wordfence-format feed URL       |
| `vulndb.wpscanTokenRef`     | none                     | `secret:` ref to the WPScan token      |
| `vulndb.wpscanBaseUrl`      | none                     | WPScan base URL override               |

Per site: `id` (lowercase letters, digits, `-`), `name`, `url`, `transport`, and optional `healthUrls` (default `/`, `/wp-login.php`, `/wp-json/`), `maskSelectors`, `backupLocation` (`docroot`, the default, or `outside`), `offsite` (`dir`, `rcloneRemote`, `encryptDb`), `logFiles` (default `wp-content/debug.log`, `error_log`) and `policy`.

### SSH site example

```yaml
sites:
  - id: example-ssh
    name: Example (SSH)
    url: https://example.com
    transport:
      kind: ssh
      host: example.com
      port: 22
      username: USER
      hostKeySha256: "SHA256:REPLACE_WITH_FINGERPRINT"
      wpRoot: /home/USER/public_html
      phpBinary: php # default
      toolDir: ~/.auto-wp # default
```

### Agent site example

```yaml
sites:
  - id: example-agent
    name: Example (agent)
    url: https://example.com
    transport:
      kind: agent
      endpoint: https://example.com/auto-wp-agent/agent.php
      keyId: k1
      signingKeyRef: secret:example-agent-signing-key
      algorithm: ed25519 # default; or hmac-sha256
      agentSha256: "REPLACE_WITH_SHA256_OF_agent.php" # optional; refuse a changed agent
```

`endpoint` must be `https:`. Plain `http:` is accepted only for loopback hosts with `insecureHttpLoopback: true` (tests).

### Policy overrides

`policy` at the top level sets defaults. A site's own `policy` overrides single keys.

```yaml
policy:
  backupMaxAgeMinutes: 60
  dbSnapshot: auto # always | never | auto
  dbSnapshotMaxMb: 200
  updateInactive: true
  retention: { remote: 3, local: 14 }

sites:
  - id: example-ssh
    # ...
    policy:
      holds: ["plugin:woocommerce"] # type:slug keys that are never updated automatically
      backupMaxAgeMinutes: 30
      thresholds: { pixelDiffPct: 2, slowdownFactor: 1.5, slowdownMinMs: 300 }
```

Other keys: `requireApproval` (default `restore.execute`, `backup.prune`, `update.core-major`; other valid values are `update.apply` and `maintenance.set`) and `dbMigratingPlugins`.

### Secrets

A `secret:<name>` value is a reference, never the secret. The name matches `[a-z0-9][a-z0-9._/-]*`. The server resolves it in this order:
1. The environment variable `AUTOWP_SECRET_<NAME>`: the name upper-cased, every non-alphanumeric character replaced by `_`. `secret:example-agent-signing-key` becomes `AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY`.
2. The encrypted file `<dataDir>/secrets.enc` (libsodium), used when a key is supplied in `AUTOWP_SECRETS_KEY` (base64, 32 bytes), `AUTOWP_SECRETS_KEY_FILE`, or the systemd credential `autowp-secrets-key`.
3. The OS keychain, when no such key is set.

There is no command-line tool to write into the encrypted file or the keychain. `SecretStore.set()` exists in the `@auto-wp/config` API only. The simplest supported route is the environment variable, loaded from a mode-0600 file (see section 7). Never put the secret value on a command line.

## 6. Connect a site

### SSH

1. Create a dedicated ed25519 key on the machine that runs auto-wp:

   ```sh
   ssh-keygen -t ed25519 -N '' -C auto-wp -f ~/.ssh/auto-wp_ed25519
   ```

   For a passphrase-protected key, give a passphrase and rely on ssh-agent. The server only reads keys from ssh-agent.

2. Add the public key to `~/.ssh/authorized_keys` on the site, restricted to your server's egress IP:

   ```text
   from="203.0.113.10" ssh-ed25519 AAAA...your-public-key... auto-wp
   ```

3. Pin the host key. Read its fingerprint over a network path you trust, ideally compare it with the value shown in your host's control panel:

   ```sh
   ssh-keyscan -p 22 example.com 2>/dev/null | ssh-keygen -lf -
   ```

   Copy the `SHA256:...` value of one key the server offers (ED25519 if listed, otherwise RSA) into `hostKeySha256`. Use the site's real SSH port with `-p`. Connections to any other key are refused.

4. Load the key into ssh-agent in the environment that starts the server:

   ```sh
   eval "$(ssh-agent -s)"
   ssh-add ~/.ssh/auto-wp_ed25519
   ```

   The server requires `SSH_AUTH_SOCK` and refuses to connect without it. For a long-running VPS, see "SSH agent for the service user" in [deploy-vps.md](../apps/mcp-server/docs/deploy-vps.md).

### cPanel shared hosting with SSH

Most cPanel hosts offer SSH, so use the SSH transport. Nothing is installed in WordPress. auto-wp runs on your machine or VPS, logs in over SSH, and uploads its own `wp-cli.phar` and `agent.php` to `~/.auto-wp` in the account's home folder, outside `public_html`.

```text
Claude ⇄ auto-wp (your PC or VPS) ──SSH──► cPanel account ──► public_html (WordPress)
```

1. Create the key on your machine as in step 1 above.
2. In cPanel, open **Security → SSH Access → Manage SSH Keys → Import Key**. Paste the contents of `~/.ssh/auto-wp_ed25519.pub`, then click **Authorize**.
   - To limit the key to your VPS, edit `~/.ssh/authorized_keys` with File Manager or the cPanel Terminal. Put `from="203.0.113.10" ` in front of that key's line.
   - Skip this if you run auto-wp from a home PC whose IP changes.
3. Collect the login details:
   - **Username:** the cPanel username.
   - **Host:** your domain or server name.
   - **Port:** many hosts use a port other than 22, such as 2222. Check the host's SSH docs.
4. Check the command-line PHP version. In the cPanel Terminal, run `php -v`. If it's older than the site's PHP (shown in **MultiPHP Manager**), set `phpBinary` to the right binary. On cPanel servers it is usually `/opt/cpanel/ea-phpXY/root/usr/bin/php`, for example `ea-php82`.
5. Pin the host key as in step 3 above, using the host's SSH port with `-p`.
6. Add the site to your config:

   ```yaml
   sites:
     - id: my-site
       name: My Site
       url: https://example.com
       transport:
         kind: ssh
         host: example.com
         port: 22 # the host's SSH port
         username: cpaneluser
         hostKeySha256: "SHA256:REPLACE_WITH_FINGERPRINT"
         wpRoot: /home/cpaneluser/public_html
         # phpBinary: /opt/cpanel/ea-php82/root/usr/bin/php # only if `php -v` is too old
   ```

   For an addon domain or subdomain, set `wpRoot` to that site's document root, as shown in cPanel under **Domains**.
7. Load the key into ssh-agent (step 4 above) and start Claude from the same terminal (section 7). Then run `site_probe`.

cPanel tips:
- **Disk quota:** each backup is a full copy of the files and database under `public_html/auto-wp-backup/`. Check the quota in cPanel before the first run. By default 3 backups are kept on the server (`retention.remote`). `backup_pull` copies them to your machine.
- **Login blocks:** if logins start failing after a few attempts, cPHulk or the host's firewall may have blocked your IP. Ask the host to allowlist your VPS IP.
- **No SSH:** if the host offers no SSH at all, use the agent below.

### Agent

Use this when the host has no SSH.
1. Generate an ed25519 key pair on the machine that runs auto-wp. The private seed stays here. The site only receives the public key.

   ```sh
   umask 077
   mkdir -p ~/.config/auto-wp
   node -e '
   const c = require("node:crypto");
   const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
   const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
   const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
   const fs = require("node:fs");
   fs.writeFileSync(process.env.HOME + "/.config/auto-wp/example-agent.seed", seed + "\n", { mode: 0o600 });
   fs.writeFileSync(process.env.HOME + "/.config/auto-wp/example-agent.pub", pub + "\n");
   '
   ```

2. Copy `agent-php/dist/agent.php` and `agent-php/bin/install.php` to the host (for example into `/home/USER/auto-wp-install/`). If you changed the agent source, rebuild first with `php agent-php/bin/build.php` (needs `composer install` in `agent-php/`).

3. Run the installer on the host. It deploys into `<docroot>/auto-wp-agent/` and keeps the real config, with the key, in a private data directory outside the docroot when it can.

   ```sh
   php install.php \
     --docroot /home/USER/public_html \
     --site-id example-agent \
     --key-id k1 \
     --ed25519-public-key "$(cat example-agent.pub)" \
     --allow-ip 203.0.113.10 \
     --expires-at 2027-12-31T00:00:00Z \
     --agent ./agent.php
   ```

   Flags (from `agent-php/bin/install.php`):

   | Flag                                 | Meaning                                                                 |
   | ------------------------------------ | ----------------------------------------------------------------------- |
   | `--docroot`, `--site-id`, `--key-id` | Required                                                                |
   | `--ed25519-public-key <base64>`      | Public key (or use `--hmac-key-file <path\|->` for HMAC; never on argv) |
   | `--wp-root <path>`                   | WordPress root if it differs from the docroot                           |
   | `--allow-ip <ip>`                    | IP allowlist; repeat the flag. CIDR is accepted.                        |
   | `--expires-at <time>`                | Kill switch: the agent refuses web requests after this time             |
   | `--data-dir <path>`                  | Private data dir (default: next to the docroot, `.auto-wp-agent-data`)  |
   | `--outside-docroot-dir <path>`       | Directory outside the docroot the agent may use                         |
   | `--agent <path>`                     | Path to `agent.php` (default `../dist/agent.php`)                       |
   | `--config-mode <octal>`              | Config file mode (default `0640`)                                       |
   | `--force`                            | Overwrite an existing install                                           |
   | `--allow-data-in-docroot`            | Allow the data dir inside the docroot (deny rules are written)          |
   | `--allow-insecure-http`              | Accept plain HTTP. Tests only.                                          |
   | `--trust-forwarded-proto`            | Treat `X-Forwarded-Proto: https` as HTTPS, only behind a trusted proxy  |
   | `--extract-links`                    | Let archive extraction create symlinks and hard links (validated)       |

   The installer prints the `sha256` of the installed `agent.php`. Put it in `agentSha256` if you want auto-wp to refuse a modified agent.

4. Make the signing key available to the server (section 5, "Secrets"). With the example above, the environment variable is `AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY` and its value is the contents of `example-agent.seed`.

5. Add the site to `config.yaml` as in the agent example in section 5.

### cPanel shared hosting without SSH

Use the agent when the host gives no SSH or Terminal. You need an HTTPS certificate on the site; cPanel's free AutoSSL is enough. The installer is a command-line PHP script, so without a shell you run it once as a cPanel cron job.

```text
Claude ⇄ auto-wp (your PC or VPS) ──HTTPS, signed requests──► public_html/auto-wp-agent/agent.php ──► WordPress
```

1. Generate the key pair on your machine (Agent, step 1 above). Only the **public** key (`example-agent.pub`) goes to the host.
2. In cPanel **File Manager**, create `/home/cpaneluser/auto-wp-install/`, outside `public_html`. Upload `agent-php/dist/agent.php` and `agent-php/bin/install.php` into it.
3. Open **Advanced → Cron Jobs**. Add a job set to run every minute, with this command on one line:

   ```sh
   php /home/cpaneluser/auto-wp-install/install.php --docroot /home/cpaneluser/public_html --site-id my-site --key-id k1 --ed25519-public-key PASTE_PUBLIC_KEY_BASE64 --allow-ip 203.0.113.10 --expires-at 2027-12-31T00:00:00Z --agent /home/cpaneluser/auto-wp-install/agent.php > /home/cpaneluser/auto-wp-install/install.log 2>&1
   ```

   - If `php` is not found or is too old, use the full path to a binary, for example `/opt/cpanel/ea-php82/root/usr/bin/php`. **MultiPHP Manager** shows the version the site uses.
   - The public key is not secret, so it is fine in the cron command. Never put the private seed on the host.
4. Wait a minute or two, then **delete the cron job**. Check the result in File Manager:
   - `public_html/auto-wp-agent/` exists, with `agent.php`, `config.php` and deny rules.
   - The private data dir `/home/cpaneluser/.auto-wp-agent-data/` exists, outside `public_html`.
   - `install.log` may say `... exists (use --force to overwrite)`. That comes from a later cron run and means the first run worked.
   - Any other `install:` error in the log means it failed. For example, if the home folder is not writable, the data dir would land inside the docroot, which the installer refuses without `--allow-data-in-docroot`.
5. Delete the `auto-wp-install/` folder.
6. Add the site to your config:

   ```yaml
   sites:
     - id: my-site # must equal --site-id
       name: My Site
       url: https://example.com
       transport:
         kind: agent
         endpoint: https://example.com/auto-wp-agent/agent.php
         keyId: k1 # must equal --key-id
         signingKeyRef: secret:my-site-agent-key
   ```

   Then make the seed available as `AUTOWP_SECRET_MY_SITE_AGENT_KEY`, loaded from a file by the launcher script in section 7. Start the server and run `site_probe`.

Notes for the agent on cPanel:
- **Behind Cloudflare or another proxy:** the IP allowlist checks the connecting IP (`REMOTE_ADDR`), which is then the proxy's, not your VPS's. Either leave out `--allow-ip` and rely on the signature, or add the proxy's IP ranges.
- **Security plugins and ModSecurity:** a WAF can block the agent's signed POST requests, usually with 403 or 406. The agent itself answers 404 to anything it rejects. If you see 403 or 406, allowlist `/auto-wp-agent/agent.php` in the security plugin, or ask the host about the ModSecurity rule.
- **Long operations:** backups and upgrades run as resumable jobs in short time slices, so they stay under shared-host `max_execution_time`.
- **When you're done:** let `--expires-at` pass, or delete `public_html/auto-wp-agent/` and `~/.auto-wp-agent-data/` in File Manager. To reinstall later, repeat steps 2–5; the installer needs `--force` to overwrite an existing install.

### Verify with `site_probe`

Start the server (section 7) and ask the assistant to run `site_probe` for the site. It reports WordPress, PHP, shell, WP-CLI and the WordPress root. Fix any error before you go on.

## 7. Run the MCP server

The entry point is `apps/mcp-server/bin/auto-wp-mcp.mjs`. It runs the TypeScript source through `tsx`, so there is no build step. Run `node apps/mcp-server/bin/auto-wp-mcp.mjs --help` for the full option list.

### Environment variables

| Variable                                        | Meaning                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `AUTOWP_CONFIG`                                 | Config file path (same as `--config`)                                      |
| `AUTOWP_SECRET_<NAME>`                          | Value for `secret:<name>`                                                  |
| `AUTOWP_SECRETS_KEY`, `AUTOWP_SECRETS_KEY_FILE` | Key for the encrypted secrets file                                         |
| `AUTOWP_AGENT_PHP`                              | `agent.php` that is deployed over SSH (default `agent-php/dist/agent.php`) |
| `AUTOWP_WORDFENCE_FEED_URL`                     | Wordfence feed override                                                    |
| `AUTOWP_PLAYWRIGHT=0`                           | HTTP-only health snapshots (no browser screenshots)                        |
| `AUTOWP_LOG_LEVEL`                              | pino log level (default `info`; also `--log-level`)                        |
| `AUTOWP_FAKE=1`                                 | Fake services. Nothing reaches a site. For trying the tools only.          |
| `AUTOWP_TEST_APPROVE=1`                         | Auto-approves gated actions. **Tests only. Never set it for real sites.**  |
| `SSH_AUTH_SOCK`                                 | ssh-agent socket (required for SSH sites)                                  |

### stdio (Claude Code, Claude Desktop)

Keep secrets out of the command line. Create a small launcher that reads them from a mode-0600 file:

```sh
install -m 700 /dev/null ~/.config/auto-wp/run.sh
cat > ~/.config/auto-wp/run.sh <<'SH'
#!/bin/sh
# Loads secrets from files, then starts the server on stdio.
AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY="$(cat "$HOME/.config/auto-wp/example-agent.seed")"
export AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY
export AUTOWP_CONFIG="$HOME/.config/auto-wp/config.yaml"
exec node /path/to/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --stdio
SH
```

Replace `/path/to/auto-wp` with your checkout. Make sure `SSH_AUTH_SOCK` is set in the environment that starts Claude.

Claude Code:

```sh
claude mcp add auto-wp -- ~/.config/auto-wp/run.sh
claude mcp list
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "auto-wp": {
      "command": "/home/USER/.config/auto-wp/run.sh",
      "args": []
    }
  }
}
```

If you have no secrets in env vars (an SSH-only setup), you can call node directly:

```sh
claude mcp add auto-wp -e AUTOWP_CONFIG=/home/USER/.config/auto-wp/config.yaml -- node /path/to/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --stdio
```

Logs go to stderr. Stdout is the MCP channel.

### Streamable HTTP behind Caddy

For a VPS, run the server with `--http` on loopback, put Caddy in front for TLS, and use bearer tokens. Create a token with:

```sh
node apps/mcp-server/bin/auto-wp-mcp.mjs --gen-token laptop
```

It prints the token once and the `AUTOWP_MCP_TOKENS` entry to store (only the sha256 is kept on the server). The server refuses to start in `--http` mode with no tokens. The systemd unit, Caddyfile, firewall rules and `claude mcp add --transport http ...` are in [apps/mcp-server/docs/deploy-vps.md](../apps/mcp-server/docs/deploy-vps.md).

### Docker on a VPS (Claude Code on your computer)

Use this when Claude Code runs on your own computer and auto-wp should run in Docker on a VPS. Sites are reached from the VPS, for example cPanel sites through the agent. The full walkthrough is in [deploy/docker/README.md](../deploy/docker/README.md).

```text
Claude Code (your computer) ──HTTPS + bearer token──► VPS: Caddy (TLS) ──► auto-wp container ──HTTPS, signed──► cPanel sites (agent)
```

`deploy/docker/compose.yaml` runs two containers:
- **Caddy**, which gets a Let's Encrypt certificate for your domain and is the only container with published ports (80 and 443).
- **auto-wp**, with no published port. It runs as non-root on a read-only filesystem with no capabilities, and its data is in the `auto-wp-data` volume.

In short:
1. On the VPS, point a DNS name such as `mcp.example.com` at it and open only ports 22, 80 and 443.
2. Set up the files:

   ```sh
   git clone https://github.com/ratnayake/auto-wp.git /opt/auto-wp
   cd /opt/auto-wp/deploy/docker
   cp .env.example .env              # set AUTOWP_DOMAIN
   cp config.example.yaml config.yaml
   install -d -m 700 secrets
   ```

3. Create a token for Claude Code. Put the printed `laptop:<sha256>` entry into `AUTOWP_MCP_TOKENS` in `.env` and keep the token itself:

   ```sh
   docker compose build
   docker compose run --rm auto-wp --gen-token laptop
   ```

4. For each site:
   - Generate an agent key pair. The private seed goes into `secrets/<name>`, owned by uid 1000 and mode 600.
   - Install the agent on the host with the public key and `--allow-ip <VPS IP>` (see [cPanel shared hosting without SSH](#cpanel-shared-hosting-without-ssh)).
   - Add the site to `config.yaml` with `signingKeyRef: secret:<name>`.

   At start-up the container turns each file in `secrets/` into `AUTOWP_SECRET_<NAME>`, so secrets never appear in the compose file, the command line or the logs.
5. Start the stack and check it:

   ```sh
   docker compose up -d
   curl -fsS https://mcp.example.com/healthz && echo OK
   ```

6. On your computer:

   ```sh
   claude mcp add --transport http auto-wp https://mcp.example.com/mcp \
     --header "Authorization: Bearer awp_xxxxxxxx"
   ```

In Docker, `backup_verify` with `deep=true` (the restore drill in a throwaway MariaDB container) is skipped with a warning, because the container has no Docker access. Don't mount the Docker socket into it. Set `AUTOWP_PLAYWRIGHT_IMAGE=0` in `.env` for a smaller image without Chromium; health checks are then HTTP-only.

## 8. First maintenance run

Ask the assistant in plain words. For example:

> Run a maintenance pass on `example-ssh`. List the sites, probe it, make a backup and verify it, then check updates and show me the plan. Do a dry run of the update first. If it looks right, apply it, wait for it to finish and generate the report.

The assistant calls these tools, in this order:
1. `sites_list` and `site_probe`: confirm the site and the connection.
2. `backup_create`: starts an async run and returns a `runId`. It verifies the backup when it finishes. `backup_verify` verifies again, and with `deep=true` also test-restores.
3. `updates_check`: pending updates with known vulnerabilities. `updates_plan`: what would be applied and what is held back, and why.
4. `updates_apply` with `dryRun=true`, then for real. It needs the `backupId` of a backup that was verified within the policy window.
5. `run_status` until the run finishes, then `report_generate` (`md`, `html` or `json`).

What you need to know:
- **Backup precondition.** `updates_apply` is refused unless the named backup passed verification within `backupMaxAgeMinutes` (default 60 minutes). Verification results live in the server process. After a restart, run `backup_verify` again.
- **Per-item rollback.** Updates run one at a time with a health check after each. A failing item is rolled back from its snapshot. The outcome is `failed-rolled-back`, or `failed-rollback-failed` if the rollback itself failed, in which case the run tells you to use `restore_plan` with the verified backup. The other outcomes are `updated`, `skipped`, `held` and `dry-run`.
- **Approvals.** Gated actions (`restore.execute`, `backup.prune`, `update.core-major` by default) need a human. The server asks through MCP elicitation and shows the plan hash. You confirm by typing its first 8 characters. If the client cannot elicit, the server falls back to a terminal prompt, but only when its own stdin is a terminal (not the case under stdio). Otherwise it refuses. A core major update only runs when you call `updates_apply` with `allowCoreMajor=true` and approve it; if you decline, the rest of the run continues without core.
- **Other tools.** `site_snapshot` and `site_compare` take and compare health snapshots yourself. `maintenance_set` toggles maintenance mode.

## 9. Restore and housekeeping

- **Restore.** Run `restore_plan` with a `backupId` and a `scope` (`full`, `db` or `files`). It changes nothing and returns a `planHash` and the steps. Then run `restore_execute` with that `planHash`. It needs your approval and overwrites the live site. It starts an async run, so poll `run_status`.
- **Prune.** `backup_prune` keeps the newest `keep` backups (default 3) and deletes the rest after approval. Use `dryRun=true` to list what would go. No approval is needed for a dry run.
- **Pull.** `backup_pull` copies a backup off the server into local storage. `backup_create` does this by default (`pull=true`).
- **Audit.** `audit_tail` shows the latest audit entries (default 50, up to 500).

## 10. Vulnerability data

Vulnerability data comes from providers, tried in this order. The first one that answers wins. Later ones are used only when the earlier ones error.
1. **Wordfence Intelligence.** Used only when you configure `vulndb.wordfenceApiKeyRef` or a feed URL (`vulndb.wordfenceFeedUrl` or `AUTOWP_WORDFENCE_FEED_URL`). Without either, it is not used. The production feed needs an API key; a mirror may not.
2. **WPScan** (fallback). Used when `vulndb.wpscanTokenRef` is set. `vulndb.wpscanBaseUrl` overrides the API base.

```yaml
vulndb:
  wordfenceApiKeyRef: secret:wordfence-api-key
  wpscanTokenRef: secret:wpscan-token
```

```sh
export AUTOWP_SECRET_WORDFENCE_API_KEY="$(cat ~/.config/auto-wp/wordfence.key)"
export AUTOWP_SECRET_WPSCAN_TOKEN="$(cat ~/.config/auto-wp/wpscan.token)"
```

With no source configured, the server logs a warning and reports show the lookups as failed.

The reports carry the providers' attribution text. Check the Wordfence Intelligence attribution requirements and terms of use yourself before you use or redistribute the data, and the same for WPScan.

## 11. Troubleshooting and known limitations

- **500 errors for up to 120 seconds after a full file restore.** Apache/PHP can serve stale `realpath()` cache entries for files the restore removed (`realpath_cache_ttl`). A rollback that runs into this is reported as `failed-rollback-failed`. Wait two minutes and check the site, then retry.
- **Per-item snapshots are never pruned.** Snapshots in `auto-wp-backup/<runId>/items` are not removed by `backup_prune`. Delete old ones by hand.
- **SFTP downloads are slow** (about 1.4 MB/s). Large `backup_pull` runs take time.
- **`sftp+agent` is not supported yet.** The config schema accepts it but the server refuses it. Use `ssh` or `agent`.
- **The agent answers HTTP 404 for any auth failure**, with no reason. Check, in order:
  - the clock: the server and the host must agree within 300 seconds;
  - `keyId` in `config.yaml` matches `--key-id`;
  - the site id matches `--site-id`;
  - your server's egress IP is in `--allow-ip`;
  - `--expires-at` has not passed;
  - the signing key is the private half of the public key you installed.

  The agent writes failures to its audit log in the data directory.
- **Host key mismatch.** The error reads `Host key mismatch for <host>: expected ... but the server presented ...`. Do not edit the pin to make it go away. Find out why the key changed (server rebuilt, or an attacker in the path) by asking the host, re-read the fingerprint (section 6), and update `hostKeySha256` only when it is legitimate.
- **`ssh-agent is required but SSH_AUTH_SOCK is not set`.** Start ssh-agent and `ssh-add` the key in the environment that starts the server.
- **`cannot read agent.php`.** The SSH transport uploads `agent.php`. Build it with `php agent-php/bin/build.php` or set `AUTOWP_AGENT_PHP`.
- **Screenshots missing.** Without Playwright and Chromium, snapshots are HTTP-only. Set `AUTOWP_PLAYWRIGHT=0` to silence the warning.
- **`updates_apply` says there is no passing verification.** Run `backup_create` or `backup_verify` again, then retry with that `backupId`.

## 12. Security checklist

- Harden the VPS: SSH keys only, a firewall that exposes only 22, 80 and 443, unattended security upgrades, and a static egress IP that you allowlist on each host.
- Never store WordPress admin passwords. auto-wp does not need them.
- Never put `restore_execute`, `backup_prune` or a core major update on a client allowlist. Keep the approval prompt.
- Keep `AUTOWP_TEST_APPROVE` unset outside tests.
- Keep secrets in files with mode 0600, or in the encrypted store. Never on a command line, in `config.yaml` or in logs.
- Use `from="<egress IP>"` on the SSH key, and pin each host key.
- Use `--allow-ip` and `--expires-at` on every agent. Remove the agent (`<docroot>/auto-wp-agent/` and its data directory) when you stop using it, or let it expire.
- Check that `<site root>/auto-wp-backup` is not served over HTTP. The backup step checks this and expects 401, 403 or 404.

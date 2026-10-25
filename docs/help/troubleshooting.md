# Troubleshooting

In this page you find the symptom you see, the likely cause and the fix.

## Connecting and probing

| Symptom                                                                   | Cause                                                        | Fix                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude mcp list` shows the server as failed (HTTP)                       | Wrong URL, DNS not ready, or the token is wrong              | Open `https://mcp.example.com/healthz`. It should return `ok`. Check `AUTOWP_DOMAIN` and the token entry in `.env`. Run `docker compose up -d --force-recreate auto-wp` after changes.                                        |
| Server exits with `AUTOWP_MCP_TOKENS is empty`                            | `--http` needs at least one token                            | Create a token with `--gen-token` and put the entry in `.env`. See [Docker on a VPS](/deploy/docker-vps#_3-create-an-access-token-for-claude-code).                                                                           |
| `ssh-agent is required but SSH_AUTH_SOCK is not set`                      | No ssh-agent in the environment that starts the server       | Start ssh-agent, then `ssh-add` the key, in the same environment. See [Any host with SSH](/sites/ssh-generic#_4-load-the-key-into-ssh-agent).                                                                                 |
| `Host key mismatch for <host>: expected ... but the server presented ...` | The pinned `hostKeySha256` does not match the server's key   | Do not edit the pin to make it go away. Find out why the key changed (server rebuilt, or an attacker in the path) by asking the host. Re-read the fingerprint, and update `hostKeySha256` only when the change is legitimate. |
| `cannot read agent.php`                                                   | The SSH transport uploads `agent.php` but cannot find it     | Build it with `php agent-php/bin/build.php` or set `AUTOWP_AGENT_PHP`.                                                                                                                                                        |
| `sftp+agent` is rejected                                                  | The schema accepts it but the server does not support it yet | Use `ssh` or `agent`.                                                                                                                                                                                                         |

## The agent answers 404 {#the-agent-answers-404}

The agent answers HTTP 404 for **any** auth failure, with no reason. Check these in order:

| Check   | What to look at                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------ |
| Clock   | The server and the host must agree within 300 seconds.                                           |
| Key ID  | `keyId` in the config matches `--key-id`.                                                        |
| Site ID | The site `id` matches `--site-id`.                                                               |
| IP      | Your server's egress IP is in `--allow-ip`. Behind Cloudflare, the connecting IP is the proxy's. |
| Expiry  | `--expires-at` has not passed.                                                                   |
| Key     | The signing key is the private half of the public key you installed.                             |

The agent writes failures to its audit log in its data directory (for example `/home/cpaneluser/.auto-wp-agent-data/`).

| Symptom                                                | Cause                                          | Fix                                                                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 403 or 406 instead of 404                              | A WAF or ModSecurity blocks the signed POST    | Allowlist `/auto-wp-agent/agent.php` in the security plugin, or ask the host about the ModSecurity rule.                                                       |
| `install.log` says `exists (use --force to overwrite)` | A later cron run found the first run's install | Good news: the first run worked. Delete the cron job.                                                                                                          |
| `install.log` has another `install:` error             | The install failed                             | Read the message. If the home folder is not writable, the data dir would be inside the docroot, which the installer refuses without `--allow-data-in-docroot`. |
| `php: command not found` in the cron log               | The cron `php` is missing or old               | Use the full path, for example `/opt/cpanel/ea-php82/root/usr/bin/php`.                                                                                        |

## Backups and updates

| Symptom                                                    | Cause                                                                                                            | Fix                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `updates_apply` says there is no passing verification      | No backup was verified within `backupMaxAgeMinutes`, or the server restarted (verification lives in the process) | Run `backup_create` or `backup_verify` again, then retry with that `backupId`.                                               |
| `backup_verify` with `deep=true` is skipped with a warning | No Docker access (always the case inside the Docker deployment)                                                  | Expected. The normal verification still runs. Do not mount the Docker socket.                                                |
| Screenshots are missing, or a warning about Playwright     | No Playwright or Chromium, so snapshots are HTTP-only                                                            | Set `AUTOWP_PLAYWRIGHT=0` to silence the warning, or use the full image (`AUTOWP_PLAYWRIGHT_IMAGE=1`).                       |
| 500 errors for up to 120 seconds after a full file restore | Apache and PHP serve stale `realpath()` cache entries (`realpath_cache_ttl`)                                     | Wait two minutes and check the site. A rollback that hits this is reported as `failed-rollback-failed`, so retry afterwards. |
| An item ends as `failed-rollback-failed`                   | The update failed and the rollback failed too                                                                    | Use `restore_plan` with the verified backup. See [Restore](/usage/restore).                                                  |
| Large `backup_pull` takes very long                        | SFTP downloads are slow (about 1.4 MB/s)                                                                         | Wait, or pull less often.                                                                                                    |
| The disk quota fills up on the host                        | Each backup is a full copy, and per-item snapshots are never pruned                                              | Lower `retention.remote`. Delete old folders in `auto-wp-backup/<runId>/items` by hand.                                      |

## Vulnerability data

| Symptom                                      | Cause                                    | Fix                                                                            |
| -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| Reports show lookups as failed               | No vulnerability source is configured    | See [Vulnerability data](/usage/vulnerability-data).                           |
| `feed has N records, expected at least 1000` | A truncated or very small Wordfence feed | Use the real feed, or set `AUTOWP_WORDFENCE_MIN_RECORDS` for a mock or mirror. |

## Docker

| Symptom                           | Cause                                                         | Fix                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `set AUTOWP_DOMAIN in .env`       | `.env` is missing the domain                                  | Edit `.env`.                                                                                                                        |
| Secret not found for a site       | The file in `secrets/` has the wrong name or owner            | The name must match `secret:<name>`. Files must be readable by uid 1000. Recreate: `docker compose up -d --force-recreate auto-wp`. |
| Caddy cannot get a certificate    | DNS does not point at the VPS, or ports 80 and 443 are closed | Fix DNS and the firewall. Check `docker compose logs caddy`.                                                                        |
| Run state is gone after a restart | State such as verifications and restore plans is per process  | Run `backup_verify` again before `updates_apply`.                                                                                   |

## Still stuck?

Check the logs (`docker compose logs auto-wp`, or `journalctl -u auto-wp-mcp`), ask Claude to run `audit_tail`, and read the [FAQ](/help/faq).

## Next steps

- [Security checklist](/help/security-checklist).
- [FAQ](/help/faq).

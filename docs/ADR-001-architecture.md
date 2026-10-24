# ADR-001: External controller with pluggable transports

Status: accepted · 2026-10-24

## Context
We maintain several WordPress sites on shared hosting (cPanel-class: PHP + MySQL, sometimes SSH/WP-CLI, sometimes FTP only). An AI assistant should be able to drive maintenance through MCP: back up, validate the backup, detect and apply updates one at a time with rollback, compare the site before and after, and report on versions and known vulnerabilities.

## Decision
**The MCP server runs outside WordPress**, on a small VPS (or on the owner's machine), and reaches each site through a `SiteConnection` transport:

1. **SSH + WP-CLI (preferred).** ed25519 key via ssh-agent, pinned host key, per-site key restricted with `from="<VPS IP>"`. The controller uploads its own sha-verified `wp-cli.phar` and `agent.php` to `~/.auto-wp/` (outside the docroot). Nothing is web-reachable.
2. **Signed PHP agent (fallback, no SSH).** A standalone `agent.php` that does not bootstrap WordPress for its core actions. Ed25519-signed requests, timestamp plus nonce replay protection, HTTPS only, action allowlist, path jail, 404 for anything unauthenticated, IP allowlist, kill-switch expiry. See [agent-protocol.md](agent-protocol.md).

### Why not an MCP server inside a WordPress plugin
- It fails exactly when it's needed. A fatal error from a core or plugin update takes the control plane down with the site, so it can't roll back.
- It updates the code it runs on, under PHP's `max_execution_time` and memory limits.
- It adds an admin-equivalent endpoint to the attack surface it's meant to protect. Any compromised plugin in the same process can read its secrets.
- It can't give an independent view of health: no Playwright, and its backups are judged by the system being backed up.

## Security controls
- **No WP admin passwords are stored.** Secrets sit in the OS keychain locally, or on the VPS in a libsodium-encrypted file keyed via `systemd-creds`. Config holds only `secret:` refs.
- **MCP over the network:** Streamable HTTP behind Caddy TLS, OAuth 2.1 / bearer tokens, client allowlist. stdio for local use.
- **Least privilege:** reuse the site's DB user. `mysqldump` gets credentials through a 0600 defaults-extra-file, never argv.
- **Every mutating tool supports `dryRun`.** `restore_execute`, `backup_prune` and core-major updates need a plan hash plus human approval (MCP elicitation) and must never be allowlisted.
- **Hash-chained audit log, locally and on the agent.** Per-site locks prevent overlapping runs.
- **`updates_apply` refuses to run** without a backup verified within the last 60 minutes (policy).
- **Backup folder protection:** `<root>/auto-wp-backup/<id>/` gets `.htaccess` (Apache 2.2 and 2.4 syntax), `index.php` and `web.config`. Protection is then **verified over HTTP** (expect 403/404). If that check fails, the backup moves outside the docroot. Artifacts are checksummed in a signed manifest and copied off-server.

## Consequences
- The agent is effectively a signed remote-admin endpoint. It must stay small, reviewed and covered by the protocol test vectors.
- The VPS becomes a high-value target. Harden it (SSH keys only, firewall, unattended upgrades) and use a static egress IP for allowlisting.

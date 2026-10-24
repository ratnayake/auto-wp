# Deploying the MCP server on a VPS

The server runs outside WordPress and reaches sites over SSH (or the signed PHP agent). Expose it over
Streamable HTTP behind Caddy (TLS), or run it locally over stdio.

## 1. Service user and state

```sh
sudo useradd --system --create-home --home-dir /var/lib/auto-wp --shell /usr/sbin/nologin auto-wp
sudo install -d -o auto-wp -g auto-wp -m 0700 /var/lib/auto-wp/state /var/lib/auto-wp/data
sudo install -d -m 0755 /etc/auto-wp
```

Install the repo under `/opt/auto-wp` (`pnpm install --prod`), and write `/etc/auto-wp/config.json`
(an `AppConfig`: sites, policy, `stateDir`, `dataDir`).

### Tokens

```sh
pnpm -F @auto-wp/mcp-server exec tsx src/main.ts --gen-token laptop
# prints the token once, and the entry to store:  laptop:<sha256 hex>
```

Only the sha256 digest is stored. Put entries (comma or newline separated) in `/etc/auto-wp/env`
(mode 0640, group `auto-wp`):

```
AUTOWP_MCP_TOKENS=laptop:3b1f...,ci:9a77...
```

## 2. systemd unit

`/etc/systemd/system/auto-wp-mcp.service`:

```ini
[Unit]
Description=auto-wp MCP server
After=network-online.target
Wants=network-online.target

[Service]
User=auto-wp
Group=auto-wp
# Or use DynamicUser=yes with StateDirectory=auto-wp (then drop User/Group and the useradd above).
EnvironmentFile=/etc/auto-wp/env
Environment=AUTOWP_CONFIG=/etc/auto-wp/config.json
# The secrets-store master key is delivered as a credential, readable only by this service:
LoadCredential=secrets.key:/etc/auto-wp/secrets.key
Environment=AUTOWP_SECRETS_KEY_FILE=%d/secrets.key
ExecStart=/usr/bin/node /opt/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --http --host 127.0.0.1 --port 8787 --allowed-host mcp.example.com
Restart=on-failure
RestartSec=3

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=no   # V8 JIT needs W+X pages
SystemCallFilter=@system-service
CapabilityBoundingSet=
ReadWritePaths=/var/lib/auto-wp/state /var/lib/auto-wp/data

[Install]
WantedBy=multi-user.target
```

The server binds to loopback only. Binding anything else requires `--allow-remote`, which exists for
setups where a TLS proxy runs in another network namespace/container. Prefer loopback + Caddy.

## 3. Caddy (TLS)

`/etc/caddy/Caddyfile`:

```
mcp.example.com {
    encode zstd gzip
    request_body {
        max_size 1MB
    }
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1          # do not buffer SSE streams
        transport http {
            read_timeout 10m
        }
    }
    header {
        Strict-Transport-Security "max-age=31536000"
        -Server
    }
}
```

Caddy keeps the original `Host`, so pass `--allowed-host mcp.example.com` (Host/Origin validation is the
MCP spec's DNS-rebinding defence). Browser-based clients also need `--allowed-origin https://app.example.com`.

The server enforces its own limits as well: bearer auth, 1 MiB body (`--max-body-bytes`), 120 requests
per minute per token (`--rate-limit`), and 20 failed auth attempts per minute per client IP.

## 4. Firewall and egress

- Inbound: allow 22 (admin, key-only), 80 and 443 (Caddy). Do **not** open 8787.

  ```sh
  sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw enable
  ```
- Outbound: sites are reached from this VPS, so give it a **static egress IP** (reserved/elastic IP) and
  allowlist that address in each host's SSH/firewall settings (cPanel "SSH Access" IP allow, ModSecurity,
  Cloudflare, WAF rules). Optionally restrict egress to 22/443 plus the vulnerability feeds.

## 5. SSH agent for the service user

Prefer keys in an agent so private keys are not readable by the service's file permissions:

```sh
sudo -u auto-wp ssh-keygen -t ed25519 -f /var/lib/auto-wp/.ssh/id_ed25519 -N ''
```

Run a dedicated agent as a user unit (`ssh-agent -D -a /run/auto-wp/ssh-agent.sock`), add the key with
`ssh-add`, and set `SSH_AUTH_SOCK=/run/auto-wp/ssh-agent.sock` in the unit. Pin each host's key at site
registration (`hostKeySha256`); connections to any other key are refused. Add the public key to
`~/.ssh/authorized_keys` of each site, ideally with `from="<egress ip>"`.

## 6. Connecting Claude Code

Remote (HTTP):

```sh
claude mcp add --transport http auto-wp https://mcp.example.com/mcp \
  --header "Authorization: Bearer awp_xxxxxxxx"
```

Local (stdio, no network exposure; uses the local config and SSH agent):

```sh
claude mcp add auto-wp -- node /opt/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --stdio
```

Do **not** add `restore_execute` or `backup_prune` to Claude Code's `permissions.allow`: they ask for a
human confirmation (the first 8 characters of the plan hash, via MCP elicitation) and must stay
unallowlisted. `claude mcp list` should show the server as connected.

## 7. Operations

- Logs: `journalctl -u auto-wp-mcp` (pino JSON on stderr; secrets are never logged).
- Health probe for monitoring: `GET /healthz` (unauthenticated, returns 200, no data).
- Rotating a token: generate a new entry, replace it in `/etc/auto-wp/env`, `systemctl restart auto-wp-mcp`.
- Run state (backup verifications, restore plans) is per process; after a restart re-run `backup_verify`
  before `updates_apply`.

## Future: OAuth 2.1

`Authenticator` (`src/auth.ts`) is the hook for an OAuth 2.1 resource server: validate JWT access tokens
against the authorization server's JWKS (issuer, audience = this resource URL, expiry, scopes), return the
subject as the principal, and serve RFC 9728 protected-resource metadata. Bearer tokens remain the
fallback.

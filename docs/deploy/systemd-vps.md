# systemd on a VPS

In this page you run the auto-wp server as a systemd service on a VPS, with Caddy in front for TLS. Choose this if you do not want Docker, or if you need SSH sites on the VPS.

The server runs outside WordPress and reaches sites over SSH (or the signed PHP agent). It speaks Streamable HTTP behind Caddy.

::: tip Prefer Docker
[Docker on a VPS](/deploy/docker-vps) is easier to set up and update. Use systemd when you have a reason to.
:::

## 1. Service user and state

```sh
sudo useradd --system --create-home --home-dir /var/lib/auto-wp --shell /usr/sbin/nologin auto-wp
sudo install -d -o auto-wp -g auto-wp -m 0700 /var/lib/auto-wp/state /var/lib/auto-wp/data
sudo install -d -m 0755 /etc/auto-wp
```

Install the repo under `/opt/auto-wp` (`pnpm install --prod`), and write `/etc/auto-wp/config.json` (an `AppConfig`: sites, policy, `stateDir`, `dataDir`). See the [config reference](/reference/config).

### Tokens

```sh
pnpm -F @auto-wp/mcp-server exec tsx src/main.ts --gen-token laptop
```

This prints the token once, and the entry to store: `laptop:<sha256 hex>`.

Only the sha256 digest is stored. Put entries (comma or newline separated) in `/etc/auto-wp/env` (mode 0640, group `auto-wp`):

```ini
AUTOWP_MCP_TOKENS=laptop:3b1f...,ci:9a77...
```

The server refuses to start in `--http` mode with no tokens.

## 2. systemd unit

Create `/etc/systemd/system/auto-wp-mcp.service`:

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
ExecStart=/usr/bin/node /opt/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --http --host 127.0.0.1 --port 8787 --allowed-host mcp.example.com --trust-proxy 127.0.0.1
Restart=on-failure
TimeoutStopSec=40
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
# V8 JIT needs W+X pages
MemoryDenyWriteExecute=no
SystemCallFilter=@system-service
CapabilityBoundingSet=
ReadWritePaths=/var/lib/auto-wp/state /var/lib/auto-wp/data

[Install]
WantedBy=multi-user.target
```

Then enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now auto-wp-mcp
```

The server binds to loopback only. Binding anything else requires `--allow-remote`, which exists for setups where a TLS proxy runs in another network namespace or container. Prefer loopback plus Caddy.

## 3. Caddy (TLS)

Put this in `/etc/caddy/Caddyfile`:

```text
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

Caddy keeps the original `Host`, so pass `--allowed-host mcp.example.com`. Host and Origin validation is the MCP spec's defence against DNS rebinding. Browser-based clients also need `--allowed-origin https://app.example.com`.

The server enforces its own limits as well:

| Limit                                         | Default  | Option              |
| --------------------------------------------- | -------- | ------------------- |
| Bearer auth                                   | required | `AUTOWP_MCP_TOKENS` |
| Request body                                  | 1 MiB    | `--max-body-bytes`  |
| Requests per minute per token                 | 120      | `--rate-limit`      |
| Failed auth attempts per minute per client IP | 20       | none                |

Behind Caddy every connection comes from 127.0.0.1, so add `--trust-proxy 127.0.0.1`. The failed-auth limit is then keyed on the real client IP (from `X-Forwarded-For`). Otherwise all failures share one bucket. Valid tokens are never blocked by the failed-auth limiter. Also rate limit at Caddy if you expose the endpoint publicly.

## 4. Firewall and egress

- **Inbound:** allow 22 (admin, key-only), 80 and 443 (Caddy). Do not open 8787.

  ```sh
  sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw enable
  ```

- **Outbound:** sites are reached from this VPS, so give it a **static egress IP** (reserved or elastic IP). Allowlist that address in each host's SSH or firewall settings (cPanel "SSH Access" IP allow, ModSecurity, Cloudflare, WAF rules). Optionally restrict egress to 22 and 443 plus the vulnerability feeds.

## 5. SSH agent for the service user

Prefer keys in an agent, so the service's file permissions do not expose the private keys:

```sh
sudo -u auto-wp ssh-keygen -t ed25519 -f /var/lib/auto-wp/.ssh/id_ed25519 -N ''
```

1. Run a dedicated agent as a user unit: `ssh-agent -D -a /run/auto-wp/ssh-agent.sock`.
2. Add the key with `ssh-add`.
3. Set `SSH_AUTH_SOCK=/run/auto-wp/ssh-agent.sock` in the unit.
4. Pin each host's key at site registration (`hostKeySha256`). Connections to any other key are refused.
5. Add the public key to `~/.ssh/authorized_keys` of each site, ideally with `from="203.0.113.10"`.

## 6. Connect Claude Code

::: code-group

```sh [Remote (HTTP)]
claude mcp add --transport http auto-wp https://mcp.example.com/mcp \
  --header "Authorization: Bearer awp_xxxxxxxx"
```

```sh [Local (stdio)]
claude mcp add auto-wp -- node /opt/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --stdio
```

:::

The local variant has no network exposure and uses the local config and SSH agent.

::: danger Never allowlist the gated tools
Do not add `restore_execute` or `backup_prune` to Claude Code's `permissions.allow`. They ask for a human confirmation (the first 8 characters of the plan hash, through MCP elicitation) and must stay unallowlisted.
:::

`claude mcp list` should show the server as connected.

## 7. Operations

| Task                        | How                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Logs                        | `journalctl -u auto-wp-mcp` (pino JSON on stderr; secrets are never logged).                                      |
| Health probe for monitoring | `GET /healthz` (unauthenticated, returns 200, no data).                                                           |
| Rotate a token              | Generate a new entry, replace it in `/etc/auto-wp/env`, then `systemctl restart auto-wp-mcp`.                     |
| After a restart             | Run state (backup verifications, restore plans) is per process, so re-run `backup_verify` before `updates_apply`. |

## Next steps

- [Connect your sites](/guide/choose-setup).
- [Security checklist](/help/security-checklist).

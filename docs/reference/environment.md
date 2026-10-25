# Environment variables

In this page you find every environment variable and server option auto-wp reads.

## Environment variables

| Variable                       | Meaning                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `AUTOWP_CONFIG`                | Config file path (same as `--config`).                                                               |
| `AUTOWP_MCP_TOKENS`            | HTTP bearer tokens as `id:<sha256 hex of token>`, comma or newline separated. Required for `--http`. |
| `AUTOWP_SECRET_<NAME>`         | Value for `secret:<name>`. Overrides the keychain and the encrypted file.                            |
| `AUTOWP_SECRETS_KEY`           | Key for the encrypted secrets file (base64, 32 bytes).                                               |
| `AUTOWP_SECRETS_KEY_FILE`      | Path to a file with that key.                                                                        |
| `AUTOWP_AGENT_PHP`             | The `agent.php` that is deployed over SSH. Default `agent-php/dist/agent.php`.                       |
| `AUTOWP_WORDFENCE_FEED_URL`    | Wordfence feed override.                                                                             |
| `AUTOWP_WORDFENCE_MIN_RECORDS` | Minimum records a Wordfence feed must have (default 1000). Lower it only for a small mock feed.      |
| `AUTOWP_PLAYWRIGHT=0`          | HTTP-only health snapshots (no browser screenshots).                                                 |
| `AUTOWP_LOG_LEVEL`             | pino log level. Default `info`. Also `--log-level`.                                                  |
| `AUTOWP_FAKE=1`                | Fake services. Nothing reaches a site. For trying the tools only.                                    |
| `AUTOWP_TEST_APPROVE=1`        | Auto-approves gated actions. **Tests only. Never set it for real sites.**                            |
| `SSH_AUTH_SOCK`                | ssh-agent socket. Required for SSH sites.                                                            |

::: danger AUTOWP_TEST_APPROVE
This variable removes the human from the loop. Keep it unset outside tests.
:::

## Docker-only variables

These are read by `deploy/docker/compose.yaml` from `.env`.

| Variable                                | Meaning                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `AUTOWP_DOMAIN`                         | Required. Hostname of the endpoint. Becomes `--allowed-host` and the Caddy site name. |
| `AUTOWP_PLAYWRIGHT_IMAGE`               | Build argument. `0` builds an image without Chromium. Default `1`.                    |
| `AUTOWP_HTTP_PORT`, `AUTOWP_HTTPS_PORT` | Published ports for Caddy. Defaults 80 and 443.                                       |

## Server command-line options

Run `node apps/mcp-server/bin/auto-wp-mcp.mjs --help` for the live list.

| Option                   | Meaning                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `--stdio`                | Serve MCP over stdin and stdout. This is the default.                                    |
| `--http`                 | Serve MCP over Streamable HTTP.                                                          |
| `--host <addr>`          | HTTP bind address. Default `127.0.0.1`.                                                  |
| `--port <n>`             | HTTP port. Default `8787`.                                                               |
| `--allow-remote`         | Permit a non-loopback bind. Only behind a TLS reverse proxy.                             |
| `--allowed-host <name>`  | Extra accepted `Host` header, for example `mcp.example.com`. Repeatable.                 |
| `--allowed-origin <url>` | Extra accepted `Origin`. Repeatable.                                                     |
| `--trust-proxy <ip>`     | Proxy peer IP whose `X-Forwarded-For` is trusted for failed-auth throttling. Repeatable. |
| `--max-body-bytes <n>`   | HTTP request body limit. Default 1048576.                                                |
| `--rate-limit <n>`       | HTTP requests per minute per token. Default 120.                                         |
| `--config <file>`        | YAML or JSON config.                                                                     |
| `--log-level <level>`    | pino level. Default `info`.                                                              |
| `--gen-token <id>`       | Print a new token and its `AUTOWP_MCP_TOKENS` entry, then exit.                          |

## Next steps

- [Config file reference](/reference/config).
- [Security checklist](/help/security-checklist).

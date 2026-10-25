# E2E harness (`@auto-wp/e2e`)

Docker-based environment with two real WordPress 6.5.2 sites plus mock vulnerability/update feeds, and vitest
scenarios that drive the MCP server over stdio.

| Service      | Role                                                                                                                           | Host port               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `wp-ssh`     | WordPress + apache + sshd + wp-cli, user `cpuser`, key-only login                                                              | 8080 (http), 2222 (ssh) |
| `wp-locked`  | WordPress, no sshd/wp-cli, `exec`-family disabled, `max_execution_time=30`                                                     | 8081                    |
| `mock-feeds` | nginx: `wordfence-v3.json` (CVEs for contact-form-7 < 5.8.4, twentytwentyfour < 1.1, core < 6.5.5) and the breaker plugin zips | 8090                    |
| `db`         | MariaDB 10.11 (`wp_ssh`, `wp_locked`)                                                                                          | -                       |

If a default port is taken, `up.sh` picks the next free one and records it in `.tmp/ports.env` / `.tmp/env`
(`AUTOWP_E2E_PORT_*`); the tests read those.

## Run

```sh
e2e/scripts/up.sh                 # ~2 min cold: build, start, seed, write .tmp/{config.yaml,env,known_hosts}
AUTOWP_E2E=1 pnpm e2e             # source of truth for ports/paths is e2e/.tmp/env (loaded automatically)
e2e/scripts/down.sh               # compose down -v, remove .tmp, kill the ssh-agent
```

Plain `pnpm test` never starts Docker: every e2e test skips unless `AUTOWP_E2E=1`. Needs Docker, network access
(wordpress.org downloads), `ssh`, `ssh-keygen`, `python3`.

`up.sh` outputs (all under the gitignored `e2e/.tmp/`): ed25519 key, `known_hosts` + pinned `SHA256:` fingerprint,
`config.yaml` (an `AppConfig` with `site-ssh` and `site-agent`), and `env` (`AUTOWP_CONFIG`,
`AUTOWP_WORDFENCE_FEED_URL`, `AUTOWP_TEST_APPROVE=1`, `SSH_AUTH_SOCK` of a started ssh-agent holding the key,
`AUTOWP_E2E=1`). wp-cli downloads are cached in `e2e/.cache/wp-cli`.

## Seeded state (both sites)

Core 6.5.2, `contact-form-7` 5.7 (active), `classic-editor` 1.6.3 (active), theme `twentytwentyfour` 1.0 (active),
`autowp-breaker` 1.0.0 (active, harmless), 3 posts + 2 pages, `WP_DEBUG`/`WP_DEBUG_LOG` on. The mu-plugin
`fixtures/mu-plugins/fake-updates.php` offers `autowp-breaker` 2.0.0 from `http://mock-feeds/`; v2.0.0 (built by
`scripts/build-fixtures.sh` from `fixtures/plugins/autowp-breaker-2.0.0/`) calls an undefined function on `init`.

## Real vs pending

Runs and must pass now (`tests/env.e2e.test.ts`): healthy environment, seeded versions, SSH key login, wrong
`known_hosts` refused under `StrictHostKeyChecking=yes`, password auth refused, breaker v2 really fatals the site and
restoring v1 fixes it, mock feed and zip served, `wp-locked` has exec disabled (HTTP-served probe).

Gated behind `AUTOWP_E2E_REAL=1` (`tests/scenario.e2e.test.ts`): the full MCP flow over `StdioClientTransport`
against the real services, for `site-ssh` and (when the agent installed) `site-agent`: probe, protected backup,
verify (and a tampered copy failing), `updates_check` with the mock-feed CVEs, a no-op dry run, the real apply
(contact-form-7 and the theme updated, `autowp-breaker` rolled back, site 200, no `.maintenance`), the report
sections, an approved DB restore matching row counts, a full restore back to the seeded versions, and the audit
log. The `site-agent` scenario needs `agent-php/dist/agent.php`: `seed.sh` installs it on `wp-locked` via
`agent-php/bin/install.php --docroot /var/www/html --site-id site-agent --key-id <vector keyId> --ed25519-public-key
<vector pubkey> --allow-data-in-docroot --allow-insecure-http --force` (set `AUTOWP_AGENT_PHP_DIR` to use another
checkout) and `up.sh` sets `AUTOWP_E2E_AGENT=1` when it succeeded. The agent signing key reaches the server as
`AUTOWP_SECRET_SITE_AGENT_SIGNING_KEY` (the env overlay of the secret store); `AUTOWP_WORDFENCE_MIN_RECORDS=1`
lets the 3-record mock feed through the truncation guard.

Environment quirks the harness works around: the MariaDB 11 client in `wp-ssh` insists on TLS, which the
MariaDB 10.11 server lacks, and WP-CLI runs it with `--no-defaults`, so `/usr/local/bin/{mariadb,mysql,...}` wrap it
with `--skip-ssl`. The `fake-updates` mu-plugin pins the contact-form-7 offer to 5.8.4 because wordpress.org's
current release needs a newer core. After a full restore, Apache's PHP workers can fatal on stale `realpath()`
cache entries for files the restore removed for up to `realpath_cache_ttl` (120 s); the scenarios wait it out.

`AUTOWP_E2E=1` is required; with it set but `e2e/.tmp/env` missing, the run fails loudly ("run up.sh first").

The apply scenarios pass `only` (cf7, theme, breaker) so core and classic-editor stay untouched.

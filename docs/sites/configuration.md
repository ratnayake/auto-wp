# Configuration, policy and secrets

In this page you learn where the config file lives, what goes in it, how policy works and how secrets are kept out of it.

auto-wp reads one YAML (or JSON) file. The schema is `AppConfigSchema` in [`packages/contracts/src/config.ts`](https://github.com/ratnayake/auto-wp/blob/main/packages/contracts/src/config.ts). Missing defaults are filled in for you.

## Where the file lives

The server picks the path in this order:
1. `--config <file>` on the server command line.
2. The `AUTOWP_CONFIG` environment variable.
3. `~/.config/auto-wp/config.yaml`.

If you pass neither the flag nor the variable and the default file does not exist, the server starts with no sites. If you name a file that does not exist, it fails.

```sh
mkdir -p ~/.config/auto-wp
chmod 700 ~/.config/auto-wp
```

In Docker the file is `deploy/docker/config.yaml`, mounted at `/config/config.yaml`.

## Top-level keys

| Key                         | Default                  | Meaning                                |
| --------------------------- | ------------------------ | -------------------------------------- |
| `sites`                     | (required)               | List of sites                          |
| `policy`                    | see [Policy](#policy)    | Defaults for every site                |
| `stateDir`                  | `~/.local/state/auto-wp` | Runs and audit log                     |
| `dataDir`                   | `~/.local/share/auto-wp` | Local backups, caches, `secrets.enc`   |
| `vulndb.wordfenceApiKeyRef` | none                     | `secret:` ref to the Wordfence API key |
| `vulndb.wordfenceFeedUrl`   | none                     | Custom Wordfence-format feed URL       |
| `vulndb.wpscanTokenRef`     | none                     | `secret:` ref to the WPScan token      |
| `vulndb.wpscanBaseUrl`      | none                     | WPScan base URL override               |

## Per-site keys

| Key              | Default                             | Meaning                                                                                                       |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`             | (required)                          | Lowercase letters, digits and `-`.                                                                            |
| `name`           | (required)                          | Display name.                                                                                                 |
| `url`            | (required)                          | The site's public URL.                                                                                        |
| `transport`      | (required)                          | `ssh` or `agent`. See below.                                                                                  |
| `healthUrls`     | `/`, `/wp-login.php`, `/wp-json/`   | Paths (relative to `url`) or absolute URLs checked before and after updates. The homepage is always included. |
| `maskSelectors`  | none                                | CSS selectors masked in screenshots (sliders, dates, ads).                                                    |
| `backupLocation` | `docroot`                           | `docroot` keeps backups in `<wpRoot>/auto-wp-backup`.`outside` puts them above the docroot.                   |
| `offsite`        | none                                | `dir`, `rcloneRemote`, and `encryptDb` (default `false`).                                                     |
| `logFiles`       | `wp-content/debug.log`, `error_log` | Remote log files scanned for PHP fatals, relative to `wpRoot`.                                                |
| `policy`         | none                                | Overrides single policy keys for this site.                                                                   |

## SSH site {#ssh-site}

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

| Key                | Default      | Meaning                                                               |
| ------------------ | ------------ | --------------------------------------------------------------------- |
| `host`, `username` | (required)   | Login details.                                                        |
| `port`             | `22`         | SSH port.                                                             |
| `hostKeySha256`    | (required)   | `SHA256:...` fingerprint. Connections with another key are refused.   |
| `wpRoot`           | (required)   | Absolute WordPress root on the server.                                |
| `phpBinary`        | `php`        | PHP CLI binary.                                                       |
| `toolDir`          | `~/.auto-wp` | Remote folder for `agent.php` and `wp-cli.phar`, outside the docroot. |

## Agent site {#agent-site}

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

| Key                    | Default    | Meaning                                                                     |
| ---------------------- | ---------- | --------------------------------------------------------------------------- |
| `endpoint`             | (required) | Full URL of the deployed agent. Must be `https:`.                           |
| `keyId`                | (required) | Must equal the installer's `--key-id`.                                      |
| `signingKeyRef`        | (required) | `secret:` reference to the Ed25519 seed (base64, 32 bytes) or the HMAC key. |
| `algorithm`            | `ed25519`  | Or `hmac-sha256`.                                                           |
| `agentSha256`          | none       | Expected sha256 of `agent.php`. The connection is refused on a mismatch.    |
| `insecureHttpLoopback` | `false`    | Allows plain `http:` for loopback hosts only. For tests.                    |

::: info sftp+agent
The schema accepts `kind: sftp+agent`, but the server refuses it for now. Use `ssh` or `agent`.
:::

## Policy

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

| Key                         | Default                                                  | Meaning                                                                                                                         |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `requireApproval`           | `restore.execute`, `backup.prune`, `update.core-major`   | Actions that need a human. Other valid values: `update.apply`, `maintenance.set`.                                               |
| `dbSnapshot`                | `auto`                                                   | Database snapshot before each item: `always`, `never`, or `auto` (core and listed plugins, or a database under the size limit). |
| `dbSnapshotMaxMb`           | `200`                                                    | Size limit for `auto`.                                                                                                          |
| `dbMigratingPlugins`        | `woocommerce`, `elementor`, `wordpress-seo`, `yoast-seo` | Plugins whose updates change the database, so they get a database snapshot.                                                     |
| `backupMaxAgeMinutes`       | `60`                                                     | How recent a verified backup must be for `updates_apply`.                                                                       |
| `holds`                     | none                                                     | `type:slug` keys never updated automatically, such as `plugin:woocommerce`.                                                     |
| `updateInactive`            | `true`                                                   | Whether inactive plugins and themes are updated too.                                                                            |
| `thresholds.pixelDiffPct`   | `2`                                                      | Largest accepted screenshot difference, in percent.                                                                             |
| `thresholds.slowdownFactor` | `1.5`                                                    | Largest accepted page slowdown factor.                                                                                          |
| `thresholds.slowdownMinMs`  | `300`                                                    | Slowdowns smaller than this are ignored.                                                                                        |
| `retention.remote`          | `3`                                                      | Backups kept on the site.                                                                                                       |
| `retention.local`           | `14`                                                     | Backups kept on the server.                                                                                                     |

## Secrets

A `secret:<name>` value is a reference, never the secret. The name matches `[a-z0-9][a-z0-9._/-]*`. The server resolves it in this order:
1. **Environment variable** `AUTOWP_SECRET_<NAME>`: the name upper-cased, with every non-alphanumeric character replaced by `_`. `secret:example-agent-signing-key` becomes `AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY`.
2. **Encrypted file** `<dataDir>/secrets.enc` (libsodium), used when a key is supplied in `AUTOWP_SECRETS_KEY` (base64, 32 bytes), `AUTOWP_SECRETS_KEY_FILE`, or the systemd credential `autowp-secrets-key`.
3. **OS keychain**, when no such key is set.

::: warning No command-line tool for the encrypted file
There is no command-line tool to write into the encrypted file or the keychain. `SecretStore.set()` exists in the `@auto-wp/config` API only. The simplest supported route is the environment variable, loaded from a mode-0600 file. Never put a secret value on a command line.
:::

In Docker, put each secret in a file under `secrets/`. The container turns it into the environment variable for you. See [Docker on a VPS](/deploy/docker-vps#_4-add-a-client-site-cpanel-no-ssh).

## Next steps

- [Config reference](/reference/config): compact tables of every key.
- [Your first maintenance run](/usage/first-run).

# Config file reference

In this page you find a compact lookup of every config key. For explanations and examples, see [Configuration](/sites/configuration).

The source of truth is [`packages/contracts/src/config.ts`](https://github.com/ratnayake/auto-wp/blob/main/packages/contracts/src/config.ts).

## Full example

```yaml
stateDir: /data/state
dataDir: /data/data

policy:
  backupMaxAgeMinutes: 60
  retention: { remote: 3, local: 14 }

vulndb:
  wordfenceApiKeyRef: secret:wordfence-api-key
  wpscanTokenRef: secret:wpscan-token

sites:
  - id: client1
    name: Client One
    url: https://client1.example.com
    healthUrls: ["/", "/wp-login.php", "/wp-json/"]
    transport:
      kind: agent
      endpoint: https://client1.example.com/auto-wp-agent/agent.php
      keyId: k1
      signingKeyRef: secret:client1-agent-key
    policy:
      holds: ["plugin:woocommerce"]
```

## Top level

| Key                         | Type          | Default                  |
| --------------------------- | ------------- | ------------------------ |
| `sites`                     | list of site  | required                 |
| `policy`                    | policy        | see below                |
| `stateDir`                  | string        | `~/.local/state/auto-wp` |
| `dataDir`                   | string        | `~/.local/share/auto-wp` |
| `vulndb.wordfenceApiKeyRef` | `secret:` ref | none                     |
| `vulndb.wordfenceFeedUrl`   | URL           | none                     |
| `vulndb.wpscanTokenRef`     | `secret:` ref | none                     |
| `vulndb.wpscanBaseUrl`      | URL           | none                     |

## Site

| Key                    | Type                           | Default                                 |
| ---------------------- | ------------------------------ | --------------------------------------- |
| `id`                   | string, `^[a-z0-9][a-z0-9-]*$` | required                                |
| `name`                 | string                         | required                                |
| `url`                  | URL                            | required                                |
| `transport`            | `ssh` or `agent`               | required                                |
| `healthUrls`           | list of string                 | `["/", "/wp-login.php", "/wp-json/"]`   |
| `maskSelectors`        | list of string                 | `[]`                                    |
| `backupLocation`       | `docroot` or `outside`         | `docroot`                               |
| `offsite.dir`          | string                         | none                                    |
| `offsite.rcloneRemote` | string                         | none                                    |
| `offsite.encryptDb`    | boolean                        | `false`                                 |
| `logFiles`             | list of string                 | `["wp-content/debug.log", "error_log"]` |
| `policy`               | policy override                | `{}`                                    |

## Transport: ssh

| Key             | Type          | Default      |
| --------------- | ------------- | ------------ |
| `kind`          | `ssh`         | required     |
| `host`          | string        | required     |
| `port`          | integer       | `22`         |
| `username`      | string        | required     |
| `hostKeySha256` | `SHA256:...`  | required     |
| `wpRoot`        | absolute path | required     |
| `phpBinary`     | string        | `php`        |
| `toolDir`       | string        | `~/.auto-wp` |

## Transport: agent

| Key                    | Type                       | Default   |
| ---------------------- | -------------------------- | --------- |
| `kind`                 | `agent`                    | required  |
| `endpoint`             | `https:` URL               | required  |
| `keyId`                | string                     | required  |
| `signingKeyRef`        | `secret:` ref              | required  |
| `algorithm`            | `ed25519` or `hmac-sha256` | `ed25519` |
| `agentSha256`          | string                     | none      |
| `insecureHttpLoopback` | boolean                    | `false`   |

## Policy

| Key                         | Type                                                                                              | Default                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `requireApproval`           | list of `restore.execute`, `backup.prune`, `update.core-major`, `update.apply`, `maintenance.set` | `restore.execute`, `backup.prune`, `update.core-major`   |
| `dbSnapshot`                | `always`, `never` or `auto`                                                                       | `auto`                                                   |
| `dbSnapshotMaxMb`           | number                                                                                            | `200`                                                    |
| `dbMigratingPlugins`        | list of string                                                                                    | `woocommerce`, `elementor`, `wordpress-seo`, `yoast-seo` |
| `backupMaxAgeMinutes`       | number                                                                                            | `60`                                                     |
| `holds`                     | list of `type:slug`                                                                               | `[]`                                                     |
| `updateInactive`            | boolean                                                                                           | `true`                                                   |
| `thresholds.pixelDiffPct`   | number                                                                                            | `2`                                                      |
| `thresholds.slowdownFactor` | number                                                                                            | `1.5`                                                    |
| `thresholds.slowdownMinMs`  | number                                                                                            | `300`                                                    |
| `retention.remote`          | integer                                                                                           | `3`                                                      |
| `retention.local`           | integer                                                                                           | `14`                                                     |

A site's `policy` can set any of these keys. Keys it leaves out use the top-level value.

## Secret references

Format: `secret:<name>`, where `<name>` matches `[a-z0-9][a-z0-9._/-]*`. See [Configuration, Secrets](/sites/configuration#secrets).

## Next steps

- [MCP tools](/reference/tools).
- [Troubleshooting](/help/troubleshooting).

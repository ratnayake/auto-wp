# Install the agent by hand

In this page you install the PHP agent yourself with `install.php`, when you have a shell on the host (or can run PHP another way), and learn every installer flag.

If you are on cPanel with no shell, the one-off cron job in [cPanel without SSH](/sites/cpanel-no-ssh) runs the same installer.

## 1. Generate a key pair

Generate an ed25519 key pair on the machine that runs auto-wp. The private seed stays here. The site only receives the public key.

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

## 2. Copy the files to the host

Copy `agent-php/dist/agent.php` and `agent-php/bin/install.php` to the host, for example into `/home/cpaneluser/auto-wp-install/`. If you changed the agent source, rebuild first with `php agent-php/bin/build.php` (needs `composer install` in `agent-php/`).

## 3. Run the installer

It deploys into `<docroot>/auto-wp-agent/` and keeps the real config, with the key, in a private data directory outside the docroot when it can.

```sh
php install.php \
  --docroot /home/cpaneluser/public_html \
  --site-id client1 \
  --key-id k1 \
  --ed25519-public-key "$(cat example-agent.pub)" \
  --allow-ip 203.0.113.10 \
  --expires-at 2027-12-31T00:00:00Z \
  --agent ./agent.php
```

The installer prints `installed:`, the `sha256` of the installed `agent.php`, the data dir and the endpoint path. Put the `sha256` in `agentSha256` if you want auto-wp to refuse a modified agent.

## Installer flags {#installer-flags}

| Flag                                 | Meaning                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `--docroot`, `--site-id`, `--key-id` | Required. `--site-id` and `--key-id` must match `[A-Za-z0-9_.-]{1,100}`.                                                    |
| `--ed25519-public-key <base64>`      | Public key (32 bytes, base64). Or use `--hmac-key-file <path\|->` for HMAC (at least 32 bytes, base64, never on argv).      |
| `--wp-root <path>`                   | WordPress root if it differs from the docroot. It must contain `wp-load.php`.                                               |
| `--allow-ip <ip>`                    | IP allowlist. Repeat the flag. CIDR is accepted.                                                                            |
| `--expires-at <time>`                | Kill switch: the agent refuses web requests after this time. Accepts a date such as `2027-12-31T00:00:00Z` or Unix seconds. |
| `--data-dir <path>`                  | Private data dir. Default: next to the docroot, `.auto-wp-agent-data`.                                                      |
| `--outside-docroot-dir <path>`       | Directory outside the docroot the agent may use.                                                                            |
| `--agent <path>`                     | Path to `agent.php`. Default `../dist/agent.php`.                                                                           |
| `--config-mode <octal>`              | Config file mode. Default `0640`.                                                                                           |
| `--force`                            | Overwrite an existing install.                                                                                              |
| `--allow-data-in-docroot`            | Allow the data dir inside the docroot (deny rules are written).                                                             |
| `--allow-insecure-http`              | Accept plain HTTP. Tests only.                                                                                              |
| `--trust-forwarded-proto`            | Treat `X-Forwarded-Proto: https` as HTTPS. Only behind a trusted proxy.                                                     |
| `--extract-links`                    | Let archive extraction create symlinks and hard links (validated).                                                          |

::: warning Prefer Ed25519
With Ed25519 the host holds only the public key, so a hacked site cannot sign requests. With HMAC the host holds the shared secret. Use `--hmac-key-file` only if you must.
:::

## 4. Give the server the signing key

Make the seed available to the server as an environment variable (see [Configuration, Secrets](/sites/configuration#secrets)). With the example above, the variable is `AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY` and its value is the contents of `example-agent.seed`.

## 5. Add the site to the config

```yaml
sites:
  - id: client1
    name: Client One
    url: https://client1.example.com
    transport:
      kind: agent
      endpoint: https://client1.example.com/auto-wp-agent/agent.php
      keyId: k1
      signingKeyRef: secret:example-agent-signing-key
```

Then ask Claude to probe the site.

## Remove the agent

Let `--expires-at` pass, or delete `<docroot>/auto-wp-agent/` and the data directory.

## Next steps

- [Configuration](/sites/configuration).
- [Agent protocol](/agent-protocol) for the wire format.

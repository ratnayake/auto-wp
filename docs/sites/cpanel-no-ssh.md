# cPanel without SSH (recommended)

In this page you connect a cPanel site that gives you no SSH or Terminal, by installing the auto-wp PHP agent with a one-off cron job.

The agent is a small standalone `agent.php`. The server sends it signed HTTPS requests. You need an HTTPS certificate on the site; cPanel's free AutoSSL is enough.

```text
Claude ⇄ auto-wp (your PC or VPS) ──HTTPS, signed requests──► public_html/auto-wp-agent/agent.php ──► WordPress
```

The installer is a command-line PHP script. With no shell, you run it once as a cPanel cron job.

::: info Before you start
- The auto-wp server is running ([Docker on a VPS](/deploy/docker-vps) or [local](/deploy/local-stdio)).
- You know the server's public IP (for example `203.0.113.10`) if it has a static one.
- You can log in to the client's cPanel.
  :::

## 1. Generate the key pair

The private seed stays with the server. The site only receives the **public** key.

::: code-group

```sh [Docker on a VPS]
# Run in /opt/auto-wp/deploy/docker
SITE=client1
docker compose run --rm -T --no-deps --entrypoint node auto-wp -e '
const c = require("node:crypto");
const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
console.log(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"));
console.error("PUBLIC KEY: " + publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));
' > "secrets/$SITE-agent-key"
chmod 600 "secrets/$SITE-agent-key"
sudo chown -R 1000:1000 secrets
```

```sh [Local computer]
umask 077
mkdir -p ~/.config/auto-wp
node -e '
const c = require("node:crypto");
const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const fs = require("node:fs");
fs.writeFileSync(process.env.HOME + "/.config/auto-wp/client1.seed", seed + "\n", { mode: 0o600 });
fs.writeFileSync(process.env.HOME + "/.config/auto-wp/client1.pub", pub + "\n");
'
```

:::

Copy the public key (the `PUBLIC KEY:` line, or the contents of `client1.pub`). You paste it in step 3.

::: danger Never put the private seed on the host
Only the public key goes to cPanel. The seed stays in `secrets/` or in `~/.config/auto-wp/`, with mode 600.
:::

## 2. Upload the installer and agent

1. In cPanel **File Manager**, create `/home/cpaneluser/auto-wp-install/`, outside `public_html`.
2. Upload `agent-php/dist/agent.php` and `agent-php/bin/install.php` from your checkout into it.

If you changed the agent source, rebuild first with `php agent-php/bin/build.php` (this needs `composer install` in `agent-php/`).

## 3. Add a one-time cron job

1. Open **Advanced → Cron Jobs**.
2. Add a job that runs every minute, with this command on **one line**:

   ```sh
   php /home/cpaneluser/auto-wp-install/install.php --docroot /home/cpaneluser/public_html --site-id client1 --key-id k1 --ed25519-public-key PASTE_PUBLIC_KEY_BASE64 --allow-ip 203.0.113.10 --expires-at 2027-12-31T00:00:00Z --agent /home/cpaneluser/auto-wp-install/agent.php > /home/cpaneluser/auto-wp-install/install.log 2>&1
   ```

3. Replace `PASTE_PUBLIC_KEY_BASE64` with your public key and `203.0.113.10` with your server's IP.

Notes:
- If `php` is not found or is too old, use the full path to a binary, for example `/opt/cpanel/ea-php82/root/usr/bin/php`. **MultiPHP Manager** shows the version the site uses.
- The public key is not secret, so it is fine in the cron command.
- For an addon domain or a WordPress in a subfolder, set `--docroot` to that site's document root. If WordPress is in a different folder, add `--wp-root`. The installer checks that `wp-load.php` is there.
- Flags are explained in [Install the agent by hand](/sites/agent-manual#installer-flags).

## 4. Check, then delete the cron job

Wait a minute or two, then **delete the cron job**. Check the result in File Manager:
- `public_html/auto-wp-agent/` exists, with `agent.php`, `config.php` and deny rules.
- The private data dir `/home/cpaneluser/.auto-wp-agent-data/` exists, outside `public_html`.
- `install.log` may say `... exists (use --force to overwrite)`. That comes from a later cron run and means the first run worked.
- Any other `install:` error in the log means it failed. For example, if the home folder is not writable, the data dir would land inside the docroot, which the installer refuses without `--allow-data-in-docroot`.

The installer prints the `sha256` of the installed `agent.php` into the log. Copy it if you want to pin the agent (`agentSha256`, see [Configuration](/sites/configuration#agent-site)).

Then delete the `auto-wp-install/` folder.

## 5. Add the site to your config

```yaml
sites:
  - id: client1 # must equal --site-id
    name: Client One
    url: https://client1.example.com
    transport:
      kind: agent
      endpoint: https://client1.example.com/auto-wp-agent/agent.php
      keyId: k1 # must equal --key-id
      signingKeyRef: secret:client1-agent-key
```

Then make the seed available to the server as `AUTOWP_SECRET_CLIENT1_AGENT_KEY`:
- **Docker:** the file `secrets/client1-agent-key` does this for you. Restart with `docker compose up -d --force-recreate auto-wp`.
- **Local:** load it from a file in your launcher script. See [Local (stdio)](/deploy/local-stdio).

## 6. Verify with `site_probe`

Ask Claude: "Probe client1." The probe reports WordPress, PHP, shell, WP-CLI and the WordPress root. Fix any error before you go on. If it fails, see [Troubleshooting](/help/troubleshooting#the-agent-answers-404).

## cPanel notes

| Topic                              | What to know                                                                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behind Cloudflare or another proxy | The IP allowlist checks the connecting IP (`REMOTE_ADDR`), which is then the proxy's, not your server's. Either leave out `--allow-ip` and rely on the signature, or add the proxy's IP ranges.                                                                 |
| Security plugins and ModSecurity   | A WAF can block the agent's signed POST requests, usually with 403 or 406. The agent itself answers 404 to anything it rejects. If you see 403 or 406, allowlist `/auto-wp-agent/agent.php` in the security plugin, or ask the host about the ModSecurity rule. |
| Long operations                    | Backups and upgrades run as resumable jobs in short time slices, so they stay under shared-host `max_execution_time`.                                                                                                                                           |
| Disk quota                         | Each backup is a full copy of files and database under `public_html/auto-wp-backup/`. Check the quota first. By default 3 backups are kept on the host (`retention.remote`).                                                                                    |
| When you are done                  | Let `--expires-at` pass, or delete `public_html/auto-wp-agent/` and `~/.auto-wp-agent-data/` in File Manager. To reinstall, repeat steps 2 to 4. The installer needs `--force` to overwrite an existing install.                                                |

## Next steps

- [Your first maintenance run](/usage/first-run).
- [Security checklist](/help/security-checklist).

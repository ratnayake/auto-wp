# cPanel with SSH

In this page you connect a cPanel account over SSH, using only cPanel's own screens plus a few commands on your machine.

Most cPanel hosts offer SSH, so this is a good choice when yours does. Nothing is installed in WordPress. auto-wp runs on your machine or VPS, logs in over SSH, and uploads its own `wp-cli.phar` and `agent.php` to `~/.auto-wp` in the account's home folder, outside `public_html`.

```text
Claude ⇄ auto-wp (your PC or VPS) ──SSH──► cPanel account ──► public_html (WordPress)
```

::: tip No SSH on your plan?
Use [cPanel without SSH](/sites/cpanel-no-ssh) instead.
:::

## 1. Create the key

On the machine that runs auto-wp:

```sh
ssh-keygen -t ed25519 -N '' -C auto-wp -f ~/.ssh/auto-wp_ed25519
```

## 2. Import it in cPanel

1. In cPanel, open **Security → SSH Access → Manage SSH Keys → Import Key**.
2. Paste the contents of `~/.ssh/auto-wp_ed25519.pub`, then click **Authorize**.
3. To limit the key to your VPS, edit `~/.ssh/authorized_keys` with File Manager or the cPanel Terminal. Put `from="203.0.113.10" ` in front of that key's line.

Skip the `from=` restriction if you run auto-wp from a home PC whose IP changes.

## 3. Collect the login details

| Detail   | Where to find it                                                              |
| -------- | ----------------------------------------------------------------------------- |
| Username | The cPanel username, for example `cpaneluser`.                                |
| Host     | Your domain or server name.                                                   |
| Port     | Many hosts use a port other than 22, such as 2222. Check the host's SSH docs. |

## 4. Check the PHP version

In the cPanel Terminal, run `php -v`. If it is older than the site's PHP (shown in **MultiPHP Manager**), set `phpBinary` to the right binary. On cPanel servers it is usually `/opt/cpanel/ea-phpXY/root/usr/bin/php`, for example `ea-php82`.

## 5. Pin the host key

Read the fingerprint as in [Any host with SSH](/sites/ssh-generic#_3-pin-the-host-key), using the host's SSH port with `-p`.

## 6. Add the site to your config

```yaml
sites:
  - id: client1
    name: Client One
    url: https://client1.example.com
    transport:
      kind: ssh
      host: client1.example.com
      port: 22 # the host's SSH port
      username: cpaneluser
      hostKeySha256: "SHA256:REPLACE_WITH_FINGERPRINT"
      wpRoot: /home/cpaneluser/public_html
      # phpBinary: /opt/cpanel/ea-php82/root/usr/bin/php # only if `php -v` is too old
```

For an addon domain or subdomain, set `wpRoot` to that site's document root, as shown in cPanel under **Domains**.

## 7. Load the key and probe

1. Load the key into ssh-agent:

   ```sh
   eval "$(ssh-agent -s)"
   ssh-add ~/.ssh/auto-wp_ed25519
   ```

2. Start Claude from the same terminal. See [Local (stdio)](/deploy/local-stdio).
3. Ask Claude: "Probe client1."

## cPanel tips

| Topic        | What to know                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disk quota   | Each backup is a full copy of the files and database under `public_html/auto-wp-backup/`. Check the quota in cPanel before the first run. By default 3 backups are kept on the server (`retention.remote`). `backup_pull` copies them to your machine. |
| Login blocks | If logins start failing after a few attempts, cPHulk or the host's firewall may have blocked your IP. Ask the host to allowlist your VPS IP.                                                                                                           |
| No SSH       | If the host offers no SSH at all, use [the agent](/sites/cpanel-no-ssh).                                                                                                                                                                               |

## Next steps

- [Your first maintenance run](/usage/first-run).
- [Troubleshooting](/help/troubleshooting).

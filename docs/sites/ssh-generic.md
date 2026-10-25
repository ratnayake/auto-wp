# Any host with SSH

In this page you connect a WordPress site on any host that offers SSH, using a dedicated key, a pinned host key and an ssh-agent.

Nothing is installed in WordPress. auto-wp logs in over SSH and uploads `wp-cli.phar` and `agent.php` into `toolDir` (default `~/.auto-wp`), outside the docroot.

::: tip On cPanel?
Use [cPanel with SSH](/sites/cpanel-ssh). It has the cPanel-specific clicks.
:::

## 1. Create a dedicated key

On the machine that runs auto-wp, create an ed25519 key:

```sh
ssh-keygen -t ed25519 -N '' -C auto-wp -f ~/.ssh/auto-wp_ed25519
```

For a passphrase-protected key, give a passphrase and rely on ssh-agent. The server only reads keys from ssh-agent.

## 2. Authorize the key on the site

Add the public key to `~/.ssh/authorized_keys` on the site, restricted to your server's egress IP:

```text
from="203.0.113.10" ssh-ed25519 AAAA...your-public-key... auto-wp
```

## 3. Pin the host key

Read the host key's fingerprint over a network path you trust. Ideally compare it with the value shown in your host's control panel.

```sh
ssh-keyscan -p 22 example.com 2>/dev/null | ssh-keygen -lf -
```

Copy the `SHA256:...` value of one key the server offers (ED25519 if listed, otherwise RSA) into `hostKeySha256`. Use the site's real SSH port with `-p`. Connections to any other key are refused.

## 4. Load the key into ssh-agent

In the environment that starts the server:

```sh
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/auto-wp_ed25519
```

The server requires `SSH_AUTH_SOCK` and refuses to connect without it. For a long-running VPS, see "SSH agent for the service user" in [systemd on a VPS](/deploy/systemd-vps#_5-ssh-agent-for-the-service-user).

## 5. Add the site to your config

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

See [Configuration](/sites/configuration#ssh-site) for every key.

## 6. Verify

Start Claude from the same terminal as the ssh-agent, then ask: "Probe example-ssh." Fix any error before you go on.

## Next steps

- [Your first maintenance run](/usage/first-run).
- [Troubleshooting](/help/troubleshooting).

# Docker on a VPS (recommended)

In this page you run auto-wp in Docker on a VPS, connect Claude Code on your own computer to it over HTTPS, and manage cPanel sites through the PHP agent. The sites need no SSH.

```text
Claude Code (your computer) ──HTTPS + bearer token──► VPS: Caddy (TLS) ──► auto-wp container
                                                                             │
                                          HTTPS, Ed25519-signed requests     ▼
                                     cPanel sites: public_html/auto-wp-agent/agent.php
```

- **Caddy** terminates TLS with an automatic Let's Encrypt certificate. It is the only container with published ports (80 and 443).
- **auto-wp** has no published port. It runs as a non-root user with a read-only root filesystem and no capabilities. It checks the bearer token, the Host header and its own rate limits.
- **Sites** see requests only from the VPS IP, so use that IP in each agent's `--allow-ip`.

::: info What you need
- A VPS with Docker and the compose plugin.
- A DNS name such as `mcp.example.com`.
- Claude Code on your computer.
- A cPanel account for each client site, with HTTPS.
  :::

## 1. Prepare the VPS

1. Point a DNS A record, such as `mcp.example.com`, at the VPS.
2. Open only inbound ports 22 (admin), 80 and 443:

   ```sh
   sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw enable
   ```

3. Write down the VPS's public IPv4 address, for example `203.0.113.10`. Each agent will allowlist it with `--allow-ip`.

::: tip Use a static IP
Sites only see the VPS IP. If it changes, the agents stop accepting requests. Reserve a static IP with your VPS provider.
:::

## 2. Get the code and configure

```sh
git clone https://github.com/ratnayake/auto-wp.git /opt/auto-wp
cd /opt/auto-wp/deploy/docker
cp .env.example .env
cp config.example.yaml config.yaml
install -d -m 700 secrets
```

Open `.env` and set `AUTOWP_DOMAIN` to your hostname, for example `mcp.example.com`.

| `.env` variable                         | Needed             | Meaning                                                                                              |
| --------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `AUTOWP_DOMAIN`                         | Yes                | Hostname for the endpoint. Caddy gets a certificate for it, and the server accepts only this `Host`. |
| `AUTOWP_MCP_TOKENS`                     | Yes (before start) | Bearer token entries, `id:<sha256>`, comma separated. See step 3.                                    |
| `AUTOWP_LOG_LEVEL`                      | No                 | pino log level. Default `info`.                                                                      |
| `AUTOWP_PLAYWRIGHT_IMAGE`               | No                 | `0` builds a smaller image without Chromium. Default `1`.                                            |
| `AUTOWP_HTTP_PORT`, `AUTOWP_HTTPS_PORT` | No                 | Published ports. Defaults 80 and 443.                                                                |

## 3. Create an access token for Claude Code

```sh
docker compose build
docker compose run --rm auto-wp --gen-token laptop
```

The command prints a token (`awp_...`) and the line to store (`laptop:<sha256>`).
1. Put the `laptop:<sha256>` line into `AUTOWP_MCP_TOKENS` in `.env`. Separate several tokens with commas.
2. Keep the token itself for step 6. The server stores only its hash.

::: warning Tokens are shown once
If you lose the token, make a new one and replace the entry in `.env`.
:::

## 4. Add a client site (cPanel, no SSH)

Repeat this for every site.
1. **Generate a key pair for the site** on the VPS. The private seed stays in `secrets/`. Only the public key goes to the host.

   ```sh
   SITE=client1
   docker compose run --rm -T --no-deps --entrypoint node auto-wp -e '
   const c = require("node:crypto");
   const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
   console.log(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"));
   console.error("PUBLIC KEY: " + publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));
   ' > "secrets/$SITE-agent-key"
   chmod 600 "secrets/$SITE-agent-key"
   sudo chown -R 1000:1000 secrets   # the container runs as uid 1000 (user "node")
   ```

   The public key is printed on screen. The seed goes only into the file.

   ::: details If secrets/ is already owned by uid 1000
   If `secrets/` is already owned by uid 1000 and you are another user, run the command with `sudo sh -c '...'` or as root.
   :::

2. **Install the agent** on the cPanel account with that public key and `--allow-ip 203.0.113.10` (your VPS IP). Follow [cPanel without SSH](/sites/cpanel-no-ssh), which installs it with a one-off cPanel cron job. Start at its step 2, because you already made the keys.

3. **Add the site to `config.yaml`.** The secret name in `signingKeyRef` is the file name in `secrets/`:

   ```yaml
   sites:
     - id: client1 # same as the installer's --site-id
       name: Client One
       url: https://client1.example.com
       transport:
         kind: agent
         endpoint: https://client1.example.com/auto-wp-agent/agent.php
         keyId: k1 # same as --key-id
         signingKeyRef: secret:client1-agent-key
   ```

At start-up, the container turns each file in `secrets/` into `AUTOWP_SECRET_<NAME>`. For example, `secrets/client1-agent-key` becomes `AUTOWP_SECRET_CLIENT1_AGENT_KEY`, which `secret:client1-agent-key` reads. Secrets never appear in the compose file, the command line or the logs.

## 5. Start

```sh
docker compose up -d
docker compose logs -f auto-wp      # wait for the server to start listening
curl -fsS https://mcp.example.com/healthz && echo OK
```

After you change `config.yaml`, `secrets/` or `.env`, run:

```sh
docker compose up -d --force-recreate auto-wp
```

## 6. Connect Claude Code on your computer

```sh
claude mcp add --transport http auto-wp https://mcp.example.com/mcp \
  --header "Authorization: Bearer awp_xxxxxxxx"
claude mcp list
```

Then ask Claude: "List my auto-wp sites and probe client1". If the probe works, continue to [Your first maintenance run](/usage/first-run).

::: danger Never allowlist the gated tools
Restores and prunes ask you to confirm in Claude Code. Never add `restore_execute` or `backup_prune` to Claude Code's allowed tools.
:::

## Operations

| Task             | How                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update auto-wp   | `git pull && docker compose up -d --build`                                                                                                                                                   |
| Read logs        | `docker compose logs auto-wp`. Logs are pino JSON and secrets are never logged.                                                                                                              |
| Back up the data | Run state, the audit log and pulled backups live in the `auto-wp-data` volume. Example: `docker run --rm -v auto-wp_auto-wp-data:/d -v "$PWD":/b alpine tar czf /b/auto-wp-data.tgz -C /d .` |
| Rotate a token   | Generate a new one, replace its entry in `.env`, then run `docker compose up -d auto-wp`.                                                                                                    |
| Remove a site    | Delete it from `config.yaml` and its key from `secrets/`. Delete `auto-wp-agent/` and `~/.auto-wp-agent-data/` on the host, or let `--expires-at` pass.                                      |
| Smaller image    | Set `AUTOWP_PLAYWRIGHT_IMAGE=0` in `.env`. Health checks are then HTTP-only, with no screenshot comparison.                                                                                  |

## Limitations in Docker

- **No deep backup check.** `backup_verify` with `deep=true` (a restore drill in a throwaway MariaDB container) is skipped with a warning, because the container has no Docker access. The normal verification (checksums, archive and SQL checks, comparison with the live site) still runs.
- **Restart drops run state.** Run state such as backup verifications and restore plans is kept per process. After a container restart, run `backup_verify` again before `updates_apply`.

::: danger Do not mount the Docker socket
Mounting the Docker socket into the container would enable the deep check, but it gives the container root on the VPS. Do not do it.
:::

## How the container is locked down

| Setting                                | Effect                                                 |
| -------------------------------------- | ------------------------------------------------------ |
| No published port on `auto-wp`         | Only Caddy can reach it, on a private network.         |
| `read_only: true`, `/tmp` as tmpfs     | The container cannot write to its own image.           |
| `cap_drop: [ALL]`, `no-new-privileges` | No Linux capabilities.                                 |
| Non-root user                          | Runs as the `node` user (uid 1000).                    |
| `--trust-proxy 172.30.0.2`             | Failed-login limits use the real client IP from Caddy. |

## Next steps

- [cPanel without SSH](/sites/cpanel-no-ssh): install the agent on the first site.
- [Your first maintenance run](/usage/first-run).
- [Troubleshooting](/help/troubleshooting).

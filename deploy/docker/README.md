# Running auto-wp in Docker on a VPS

This setup runs the MCP server on a VPS with Docker. Claude Code on your own computer connects to it over HTTPS, and the server manages cPanel sites through the PHP agent, so the sites need no SSH.

```text
Claude Code (your computer) ──HTTPS + bearer token──► VPS: Caddy (TLS) ──► auto-wp container
                                                                             │
                                          HTTPS, Ed25519-signed requests     ▼
                                     cPanel sites: public_html/auto-wp-agent/agent.php
```

- **Caddy** terminates TLS with an automatic Let's Encrypt certificate. It is the only container with published ports (80 and 443).
- **auto-wp** has no published port. It runs as a non-root user with a read-only root filesystem and no capabilities. It checks the bearer token, the Host header and its own rate limits.
- **Sites** see requests only from the VPS IP, so use that IP in each agent's `--allow-ip`.

## 1. Prepare the VPS

You need:
- Docker with the compose plugin;
- a DNS name for the endpoint, such as `mcp.example.com`, with an A record pointing at the VPS;
- inbound ports 22 (admin), 80 and 443 open, and nothing else.

```sh
sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Note the VPS's public IPv4 address. The agents allowlist it (`--allow-ip`).

## 2. Get the code and configure

```sh
git clone https://github.com/ratnayake/auto-wp.git /opt/auto-wp
cd /opt/auto-wp/deploy/docker
cp .env.example .env
cp config.example.yaml config.yaml
install -d -m 700 secrets
```

Set `AUTOWP_DOMAIN` in `.env` to your hostname.

## 3. Create an access token for Claude Code

```sh
docker compose build
docker compose run --rm auto-wp --gen-token laptop
```

This prints a token (`awp_...`) and the line to store (`laptop:<sha256>`):
- Put the `laptop:<sha256>` line into `AUTOWP_MCP_TOKENS` in `.env`. Separate several tokens with commas.
- Keep the token itself for step 6. The server only stores its hash.

## 4. Add a client site (cPanel, no SSH)

Repeat this for every site.
1. On the VPS, generate a key pair for the site. The private seed stays in `secrets/`, and only the public key goes to the host.

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

   If `secrets/` is already owned by uid 1000 and you are another user, run the command with `sudo sh -c '...'` or as root.

   The public key is printed on screen. The seed goes only into the file.
2. Install the agent on the cPanel account with that public key and `--allow-ip <VPS IP>`. Follow [cPanel without SSH](../../docs/sites/cpanel-no-ssh.md) (start at its step 2), which installs it with a one-off cPanel cron job.
3. Add the site to `config.yaml`. The secret name in `signingKeyRef` is the file name in `secrets/`:

   ```yaml
   sites:
     - id: client1 # same as the installer's --site-id
       name: Client One
       url: https://client1.example
       transport:
         kind: agent
         endpoint: https://client1.example/auto-wp-agent/agent.php
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

After you change `config.yaml`, `secrets/` or `.env`, run `docker compose up -d --force-recreate auto-wp`.

## 6. Connect Claude Code on your computer

```sh
claude mcp add --transport http auto-wp https://mcp.example.com/mcp \
  --header "Authorization: Bearer awp_xxxxxxxx"
claude mcp list
```

Then ask Claude, for example: "List my auto-wp sites and probe client1". Continue with [your first maintenance run](../../docs/usage/first-run.md):
1. back up;
2. verify;
3. check updates;
4. plan;
5. dry-run apply;
6. apply;
7. report.

Restores and prunes ask you to confirm in Claude Code. Never add `restore_execute` or `backup_prune` to Claude Code's allowed tools.

## Operations

- **Update auto-wp:** `git pull && docker compose up -d --build`.
- **Logs:** `docker compose logs auto-wp`. Logs are pino JSON and secrets are never logged.
- **Data:** run state, the audit log and pulled backups live in the `auto-wp-data` volume. Back it up, for example: `docker run --rm -v auto-wp_auto-wp-data:/d -v "$PWD":/b alpine tar czf /b/auto-wp-data.tgz -C /d .`
- **Rotate a token:** generate a new one, replace its entry in `.env`, then run `docker compose up -d auto-wp`.
- **Remove a site:** delete it from `config.yaml` and its key from `secrets/`. Delete `auto-wp-agent/` and `~/.auto-wp-agent-data/` on the host, or let `--expires-at` pass.
- **Smaller image:** set `AUTOWP_PLAYWRIGHT_IMAGE=0` in `.env`. Health checks are then HTTP-only, with no screenshot comparison.

## Limitations in Docker

- **No deep backup check:** `backup_verify` with `deep=true` (a restore drill in a throwaway MariaDB container) is skipped with a warning, because the container has no Docker access. The normal verification (checksums, archive and SQL checks, comparison with the live site) still runs. Do not mount the Docker socket into the container to enable it, because that gives the container root on the VPS.
- **Restart drops run state:** run state such as backup verifications and restore plans is kept per process. After a container restart, run `backup_verify` again before `updates_apply`.

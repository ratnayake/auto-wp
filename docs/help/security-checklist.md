# Security checklist

In this page you check that your setup follows the safety rules, before you manage real client sites.

auto-wp can restore, delete and update live sites, so treat the server like a high-value target.

## The server

- [ ] Harden the VPS: SSH keys only, a firewall that exposes only 22, 80 and 443, and unattended security upgrades.
- [ ] Use a static egress IP and allowlist it on each host.
- [ ] Do not open port 8787. Only Caddy faces the internet.
- [ ] Use a different bearer token for each person or tool, and rotate them if one leaks.
- [ ] Keep `AUTOWP_TEST_APPROVE` unset outside tests.
- [ ] Never mount the Docker socket into the auto-wp container.

## Secrets

- [ ] Never store WordPress admin passwords. auto-wp does not need them.
- [ ] Keep secrets in files with mode 0600, or in the encrypted store.
- [ ] Never put a secret on a command line, in `config.yaml` or in logs.
- [ ] Keep `secrets/` at mode 700 and `deploy/docker/config.yaml` out of git (both are in `.gitignore`).

## Approvals

- [ ] Never put `restore_execute`, `backup_prune` or a core major update on a client allowlist. Keep the approval prompt.
- [ ] Read the plan before you type the first 8 characters of its hash.

## Each site

- [ ] SSH sites: use `from="203.0.113.10"` on the SSH key, and pin the host key (`hostKeySha256`).
- [ ] Agent sites: use `--allow-ip` and `--expires-at` on every agent.
- [ ] Remove the agent (`<docroot>/auto-wp-agent/` and its data directory) when you stop using it, or let it expire.
- [ ] Delete the install cron job and the `auto-wp-install/` folder after installing.
- [ ] Never put the private seed on the host.
- [ ] Check that `<site root>/auto-wp-backup` is not served over HTTP. The backup step checks this and expects 401, 403 or 404.

## Next steps

- [FAQ](/help/faq).
- [Design: ADR-001](/ADR-001-architecture) for the full security reasoning.

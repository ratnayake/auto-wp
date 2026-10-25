# FAQ

In this page you find quick answers to common questions.

## Do I need a VPS?

No. You can run auto-wp on your own computer (see [Local (stdio)](/deploy/local-stdio)). A VPS is recommended because it is always on and has a static IP that you can allowlist on each host.

## Do my client sites need SSH?

No. The PHP agent works on any host that serves HTTPS with PHP 7.4 to 8.4. See [cPanel without SSH](/sites/cpanel-no-ssh).

## Does it install a plugin in WordPress?

No. With SSH it installs nothing in WordPress. With the agent it adds a folder `auto-wp-agent/` in the docroot, which you can delete at any time. See [What is auto-wp?](/guide/what-is-auto-wp).

## Does it need my WordPress admin password?

No. It never stores WordPress admin passwords.

## What if an update breaks my site?

Each update is health-checked and rolled back automatically if it fails. If the rollback fails too, you restore from the verified backup. See [How it works](/guide/how-it-works#per-item-rollback) and [Restore](/usage/restore).

## Will it update everything automatically?

It updates only what you ask for, after a verified backup. You can hold items back with `holds` (for example `plugin:woocommerce`). Restores, prunes and major core updates always need your approval.

## Where are my backups?

On the site in `<site root>/auto-wp-backup/<id>/` (protected from web access), and a pulled copy in the server's `dataDir`. By default 3 are kept on the site and 14 on the server.

## What does the report include?

Core, themes and updated plugins only, with old and new versions and known vulnerabilities. See [Reports](/usage/reports).

## Can I use Claude Desktop instead of Claude Code?

Yes, for the local stdio setup. See [Local (stdio)](/deploy/local-stdio) for the JSON. For the remote HTTP setup, the commands in these docs use Claude Code.

## Is it safe to let an AI run restores?

The restore runs only after a plan you read and a confirmation you type. Never allowlist `restore_execute` or `backup_prune`. See the [security checklist](/help/security-checklist).

## Can I try it without a real site?

Yes. See the [quick start](/guide/quick-start).

## Which vulnerability data does it use?

Wordfence Intelligence first, with WPScan as a fallback, when you configure them. See [Vulnerability data](/usage/vulnerability-data).

## Next steps

- [Troubleshooting](/help/troubleshooting).
- [Choose your setup](/guide/choose-setup).

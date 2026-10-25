# Restore and housekeeping

In this page you learn how to restore a site from a verified backup, and how to prune, pull and audit backups.

## Restore

Restoring is a two-step process, so you always see the plan first.
1. **Plan.** Ask Claude: "Make a restore plan for `client1` from backup `<backupId>`, scope `db`." This runs `restore_plan` with a `backupId` and a `scope`.
   - `full`: files and database (the default).
   - `db`: the database only.
   - `files`: the files only.

   The plan changes nothing. It returns a `planHash` and the steps.
2. **Execute.** Claude calls `restore_execute` with that `planHash`. It needs your approval (type the first 8 characters of the hash) and **overwrites the live site**. It starts an async run, so Claude polls `run_status`.

::: danger Restore overwrites the live site
Check the plan carefully. Make a fresh backup first if the site is still partly working.
:::

::: warning After a full file restore, wait two minutes
Apache and PHP can serve stale `realpath()` cache entries for files the restore removed (`realpath_cache_ttl`). You may see 500 errors for up to 120 seconds. Wait two minutes, check the site, then retry if needed.
:::

## Prune

`backup_prune` keeps the newest `keep` backups (default 3) and deletes the rest after approval.
- Use `dryRun=true` to list what would go. A dry run needs no approval.
- Per-item snapshots in `auto-wp-backup/<runId>/items` are **not** removed by `backup_prune`. Delete old ones by hand.

## Pull

`backup_pull` copies a backup off the server into local storage. `backup_create` does this by default (`pull=true`).

SFTP downloads are slow (about 1.4 MB/s), so large pulls take time.

## List and audit

- `backup_list` shows the backups for a site.
- `audit_tail` shows the latest audit entries (default 50, up to 500).

## Next steps

- [Vulnerability data](/usage/vulnerability-data).
- [Troubleshooting](/help/troubleshooting).

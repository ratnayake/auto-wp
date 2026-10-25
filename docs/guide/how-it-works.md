# How it works

In this page you follow one maintenance run from start to finish and see how rollback protects a site.

## The flow

Every run follows the same seven steps. The assistant calls the tools for you. The tool names are in the [tools reference](/reference/tools).

| #   | Step        | Tool              | What happens                                                                                                                                              |
| --- | ----------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Backup**  | `backup_create`   | Copies the database and files into `<site root>/auto-wp-backup`, and pulls a copy to the server by default. Runs in the background and returns a `runId`. |
| 2   | **Verify**  | `backup_verify`   | Checks the backup (checksums, archive and SQL checks, comparison with the live site). `deep=true` also test-restores it in a throwaway MariaDB container. |
| 3   | **Check**   | `updates_check`   | Lists pending updates and the known vulnerabilities for each.                                                                                             |
| 4   | **Plan**    | `updates_plan`    | Shows what would be applied, what is held back, and why. Changes nothing.                                                                                 |
| 5   | **Apply**   | `updates_apply`   | Updates one item at a time. Use `dryRun=true` first.                                                                                                      |
| 6   | **Compare** | `site_compare`    | Compares health snapshots taken before and after (status codes, page speed, screenshots, new log errors).                                                 |
| 7   | **Report**  | `report_generate` | Produces the report as `md`, `html` or `json`.                                                                                                            |

::: warning The backup comes first
`updates_apply` is refused unless the backup you name passed verification within the last `backupMaxAgeMinutes` (default 60 minutes). This rule is not optional.
:::

## Per-item rollback

Updates run one at a time, never as a batch. This keeps each failure small and easy to undo.

For each core, theme or plugin update:
1. **Snapshot.** auto-wp saves the files of that one item. It may also save the database, depending on the `dbSnapshot` policy (`auto` by default: core and plugins listed in `dbMigratingPlugins`, or a database under `dbSnapshotMaxMb`).
2. **Update.** It runs the update.
3. **Health check.** It requests your health URLs (`/`, `/wp-login.php` and `/wp-json/` by default) and looks for errors in the log files.
4. **Decide.**
   - Healthy: the item is marked `updated` and the next one starts.
   - Unhealthy: the item is rolled back from its snapshot and marked `failed-rolled-back`. The run carries on with the next item.
5. **If the rollback fails too,** the item is marked `failed-rollback-failed`. The run tells you to use `restore_plan` with the verified backup. See [Restore](/usage/restore).

### Outcomes you will see

| Outcome                  | Meaning                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `updated`                | Updated and healthy.                                                                                                                   |
| `skipped`                | Not applied because a safety step before the update failed (for example, the snapshot could not be made). The item was left untouched. |
| `held`                   | Held back by policy (`holds`), so never updated automatically.                                                                         |
| `dry-run`                | Shown but not applied, because `dryRun=true`.                                                                                          |
| `failed-rolled-back`     | The update failed and was undone. The site is back to how it was.                                                                      |
| `failed-rollback-failed` | The update failed and the undo failed too. Restore from the verified backup.                                                           |

## Approvals

Some steps always need a human. By default these are `restore.execute`, `backup.prune` and `update.core-major`.
1. The server shows you the plan and its hash.
2. You confirm by typing the first 8 characters of the hash.
3. Without your confirmation, the step is refused.

A core major update only runs when you call `updates_apply` with `allowCoreMajor=true` and approve it. If you decline, the rest of the run continues without core.

## Safety by design

- **Dry run.** Backup creation, update apply and prune accept `dryRun`.
- **Locks.** Each site has a lock so two runs cannot overlap.
- **Audit log.** Every action is written to a hash-chained audit log. Read it with `audit_tail`.
- **Backup folder protection.** The backup folder gets `.htaccess`, `index.php` and `web.config`, and the backup step checks over HTTP that it is not served (it expects 401, 403 or 404).

## Next steps

- [Choose your setup](/guide/choose-setup).
- [Your first maintenance run](/usage/first-run): what to say to Claude.

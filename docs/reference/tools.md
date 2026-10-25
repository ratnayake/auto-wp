# MCP tools

In this page you find all 18 MCP tools that auto-wp offers, what each one does, and how risky it is.

The list comes from `packages/contracts/src/tools.ts`. Tool names use only letters and underscores.

## Legend

| Label         | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| **read-only** | Listed in `READ_ONLY_TOOLS`. Does not change the site.                                      |
| **mutating**  | Changes something: files, the site, or stored backups.                                      |
| **gated**     | Needs human approval (plan hash and MCP elicitation). Never allowlist these in Claude Code. |
| **async**     | Starts a background run and returns `{ runId }` immediately. Poll with `run_status`.        |

## All tools

| Tool              | What it does                                                                                          | Type                            | Main inputs (defaults)                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `sites_list`      | Lists configured sites.                                                                               | read-only                       | none                                                                     |
| `site_probe`      | Reports WordPress, PHP, shell, WP-CLI and the WordPress root for a site.                              | read-only                       | `siteId`                                                                 |
| `backup_create`   | Backs up database and files, verifies the result, and pulls a copy by default.                        | mutating, async                 | `siteId`, `dryRun` (false), `pull` (true)                                |
| `backup_list`     | Lists backups for a site.                                                                             | read-only                       | `siteId`                                                                 |
| `backup_verify`   | Verifies a backup. `deep=true` also test-restores it in a throwaway MariaDB container (needs Docker). | read-only                       | `siteId`, `backupId`, `deep` (false)                                     |
| `backup_pull`     | Copies a backup off the site into local storage.                                                      | mutating                        | `siteId`, `backupId`                                                     |
| `updates_check`   | Lists pending updates with known vulnerabilities.                                                     | read-only                       | `siteId`                                                                 |
| `updates_plan`    | Shows what would be applied and what is held back, and why.                                           | read-only                       | `siteId`, `only` (list of `type:slug`)                                   |
| `updates_apply`   | Applies updates one at a time with health checks and rollback. Needs a recently verified backup.      | mutating, async                 | `siteId`, `backupId`, `only`, `allowCoreMajor` (false), `dryRun` (false) |
| `run_status`      | Shows the progress and result of a run.                                                               | read-only                       | `runId`                                                                  |
| `site_snapshot`   | Takes a health snapshot of a site.                                                                    | read-only                       | `siteId`, `label` ("manual")                                             |
| `site_compare`    | Compares two health snapshots.                                                                        | read-only                       | `siteId`, `beforeSnapshotId`, `afterSnapshotId` (optional)               |
| `report_generate` | Builds the report for a run.                                                                          | read-only                       | `runId`, `format` (`md`, `html` or `json`; default `md`)                 |
| `maintenance_set` | Turns maintenance mode on or off.                                                                     | mutating                        | `siteId`, `enabled`                                                      |
| `restore_plan`    | Plans a restore from a backup. Changes nothing and returns a `planHash`.                              | mutating (stores the plan only) | `siteId`, `backupId`, `scope` (`full`, `db` or `files`; default `full`)  |
| `restore_execute` | Executes a restore plan. Overwrites the live site.                                                    | mutating, gated, async          | `siteId`, `planHash`                                                     |
| `backup_prune`    | Deletes old backups, keeping the newest `keep`.                                                       | mutating, gated                 | `siteId`, `keep` (3), `dryRun` (false)                                   |
| `audit_tail`      | Shows the latest audit log entries.                                                                   | read-only                       | `limit` (50, 1 to 500)                                                   |

::: info Notes on the labels
- `restore_plan` is not in the code's `READ_ONLY_TOOLS` list, although it changes nothing on the site. It only stores the plan so `restore_execute` can use it.
- `site_snapshot` and `report_generate` are in the read-only list because they do not change the site.
- A dry run of `backup_prune` (`dryRun=true`) needs no approval.
  :::

## Approval by default

These actions need a human by default (policy `requireApproval`): `restore.execute`, `backup.prune`, `update.core-major`. You can also require approval for `update.apply` and `maintenance.set`. See [Configuration](/sites/configuration#policy).

## Next steps

- [Your first maintenance run](/usage/first-run).
- [Environment variables](/reference/environment).

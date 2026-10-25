# Your first maintenance run

In this page you run a full, safe maintenance pass on one site by talking to Claude, and learn what you will see and when you must approve.

## Before you start

- The server is running and `claude mcp list` shows it as connected.
- You added a site and `site_probe` passes.

## What to say

You ask in plain words. For example:

> Run a maintenance pass on `client1`. List the sites, probe it, make a backup and verify it, then check updates and show me the plan. Do a dry run of the update first. If it looks right, apply it, wait for it to finish and generate the report.

Claude calls the tools in this order. You do not need to know their names, but they help when something goes wrong.

| #   | What Claude does                                                            | Tool                               |
| --- | --------------------------------------------------------------------------- | ---------------------------------- |
| 1   | Confirms the site and the connection                                        | `sites_list`, `site_probe`         |
| 2   | Starts a backup (async, returns a `runId`) and verifies it when it finishes | `backup_create`                    |
| 3   | Optionally verifies again, with a test restore if `deep=true`               | `backup_verify`                    |
| 4   | Lists pending updates with known vulnerabilities                            | `updates_check`                    |
| 5   | Shows what would be applied, what is held back, and why                     | `updates_plan`                     |
| 6   | Rehearses the update                                                        | `updates_apply` with `dryRun=true` |
| 7   | Applies it for real. It needs the `backupId` of a verified backup.          | `updates_apply`                    |
| 8   | Waits until the run finishes                                                | `run_status`                       |
| 9   | Writes the report (`md`, `html` or `json`)                                  | `report_generate`                  |

::: tip Smaller steps are fine
You can ask for one step at a time: "Only back up and verify `client1`." Or: "Update only `plugin:contact-form-7`." (`only` takes `type:slug` keys.)
:::

## What you will see

- **Progress.** Backups and updates run in the background. Claude polls `run_status` until the run is done.
- **Item outcomes.** Each item ends as `updated`, `skipped`, `held`, `dry-run`, `failed-rolled-back` or `failed-rollback-failed`. See [How it works](/guide/how-it-works#outcomes-you-will-see).
- **A report.** See [Reports](/usage/reports).

## Rules you should know

### The backup precondition

`updates_apply` is refused unless the named backup passed verification within `backupMaxAgeMinutes` (default 60 minutes). Verification results live in the server process. After a restart, run `backup_verify` again.

If `updates_apply` says there is no passing verification, run `backup_create` or `backup_verify` again, then retry with that `backupId`.

### Approvals

Gated actions need a human: `restore.execute`, `backup.prune` and `update.core-major` by default.
1. The server asks through MCP elicitation and shows the plan hash.
2. You confirm by typing its **first 8 characters**.
3. If the client cannot elicit, the server falls back to a terminal prompt, but only when its own stdin is a terminal (not the case under stdio). Otherwise it refuses.

A core major update only runs when you call `updates_apply` with `allowCoreMajor=true` and approve it. If you decline, the rest of the run continues without core.

::: danger Keep the prompt
Never add `restore_execute` or `backup_prune` to Claude Code's allowed tools. Keep the approval prompt.
:::

### Other tools

`site_snapshot` and `site_compare` take and compare health snapshots yourself. `maintenance_set` toggles maintenance mode. `audit_tail` shows recent audit entries.

## Next steps

- [Reports](/usage/reports): read the result.
- [Restore and housekeeping](/usage/restore).

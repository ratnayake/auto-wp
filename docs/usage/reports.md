# Reports

In this page you learn what the report contains, how to read it, and how to ask for it.

Ask Claude for "the report for that run". It calls `report_generate` with the run's `runId` and a format: `md` (default), `html` or `json`. The Markdown report is also available as the resource `autowp://runs/{runId}/report.md`.

## What is in it

The report covers **core, themes and updated plugins only**. Plugins that were not updated are not listed.

| Section                       | Contents                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Backup                        | Backup ID, location, each artifact with size and SHA-256, and the verification result. |
| **1. WordPress core**         | Old and new version, and known vulnerabilities.                                        |
| **2. Themes**                 | Same, for each updated theme.                                                          |
| **3. Plugins (updated only)** | Same, for each updated plugin.                                                         |
| Failed / rolled back          | Items that failed, with the error and the outcome.                                     |
| Before/after comparison       | Per-page status, pixel difference and slowdown, plus new log errors.                   |
| Attributions                  | Credit text required by the vulnerability data providers.                              |

For each item, the vulnerability table shows the ID or CVE, title, CVSS score, affected range, the version that fixes it, and whether this update fixes it.

## Example

This is a shortened example.

```markdown
# Maintenance report: Client One

Site: https://client1.example.com

## Backup

- **Backup ID:** 2026-10-25T09-00-00Z
- **Location:** public_html/auto-wp-backup/client1
- **Verification:** passed (2026-10-25T09:04:10Z), 14 checks

## 1. WordPress core

**Version:** 6.5.2 → 6.5.5

| ID / CVE      | Title         | CVSS | Affected range | Fixed in | Fixed by this update |
| ------------- | ------------- | ---- | -------------- | -------- | -------------------- |
| CVE-2026-0000 | Example issue | 6.1  | < 6.5.5        | 6.5.5    | yes                  |

## 2. Themes

No themes were updated.

## 3. Plugins (updated only)

### Contact Form 7 (contact-form-7)

**Version:** 5.7 → 5.8.4

No known vulnerabilities.

## Failed / rolled back

| Item                  | Error               | Outcome            |
| --------------------- | ------------------- | ------------------ |
| plugin:autowp-breaker | health check failed | failed-rolled-back |

## Before/after comparison

**Overall:** OK
```

All values here are made up to show the layout.

## Reading it

- **"Fixed by this update: no"** with a warning mark means the new version is still affected. Treat it as urgent.
- **"unknown (lookup failed)"** means the vulnerability lookup failed. The report also lists the lookup errors, and says the data is incomplete.
- **Failed / rolled back** with `failed-rolled-back` means the site was restored for that item. Look at the error, then decide whether to hold that item (`holds`).
- **Overall: problems found** in the comparison means something went wrong, such as a page changing status. Read the "Problems" column of the comparison table: it also lists screenshot differences and slowdowns above your thresholds. Check those pages in a browser.

## Next steps

- [Restore and housekeeping](/usage/restore).
- [Vulnerability data](/usage/vulnerability-data).

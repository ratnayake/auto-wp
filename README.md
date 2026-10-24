# auto-wp

An MCP server that maintains WordPress sites on shared hosting. It:

1. backs up the database and files into `<site root>/auto-wp-backup/<id>/` (and off-site),
2. validates the backup,
3. detects pending core, theme and plugin updates,
4. applies them one at a time, with health checks and per-item rollback,
5. compares the site before and after,
6. reports old → new versions and known vulnerabilities (Wordfence Intelligence, with WPScan as fallback).

The controller runs **outside WordPress** (see [ADR-001](docs/ADR-001-architecture.md)). It reaches each site over SSH + WP-CLI, or through a signed standalone PHP agent ([protocol](docs/agent-protocol.md)) when SSH isn't available.

## Layout

| Path | Purpose |
|---|---|
| `packages/contracts` | Shared types, zod schemas, service interfaces, test fakes, protocol test vectors |
| `packages/config` | Site registry and secrets |
| `packages/safety` | Audit log, policy, approval gate, locks |
| `packages/transport-ssh`, `packages/transport-agent` | `SiteConnection` implementations |
| `packages/backup`, `packages/verify` | Backup creation and validation |
| `packages/inventory`, `packages/vulndb` | Update detection/planning and vulnerability intelligence |
| `packages/updater`, `packages/health` | Update execution with rollback and restore; health checks and comparison |
| `packages/report` | Report rendering |
| `agent-php/` | Standalone PHP agent |
| `apps/mcp-server` | The MCP server (stdio and Streamable HTTP) |
| `e2e/` | Docker-based end-to-end harness |

## Development

```sh
pnpm install
pnpm test        # all unit tests
pnpm typecheck
pnpm lint
pnpm e2e         # requires Docker; see e2e/README.md
```

Conventions:
- ESM and strict TypeScript.
- zod at every boundary.
- Packages import only from `@auto-wp/contracts` and their own code; `apps/mcp-server` wires them together.
- Logs go to stderr (stdout is the MCP stdio channel).
- Never put secrets in logs or argv.

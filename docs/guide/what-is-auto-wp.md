# What is auto-wp?

In this page you learn what auto-wp does, what it is made of, and why it runs outside WordPress.

auto-wp is an [MCP server](https://modelcontextprotocol.io) that maintains WordPress sites on shared hosting. You talk to an AI assistant such as Claude Code. The assistant calls auto-wp's tools to back up a site, check it, update it and report on it.

## What it does for you

- Backs up the database and files into `<site root>/auto-wp-backup`, then verifies the backup.
- Applies core, theme and plugin updates one by one, with a health check after each one and automatic rollback.
- Compares the site before and after the update.
- Reports core, themes and updated plugins only, with old and new versions and known vulnerabilities.

## The big picture

```text
 Your computer                 Your VPS                              Client hosting
┌──────────────┐   HTTPS    ┌─────────────────────────┐  HTTPS (signed)  ┌───────────────────────┐
│ Claude Code  │ ─────────► │ Caddy (TLS)             │ ───────────────► │ cPanel account        │
│ (the chat)   │  + token   │   └► auto-wp MCP server │                  │  public_html/         │
└──────────────┘            │      (Docker)           │ ──── or SSH ───► │   auto-wp-agent/      │
                            └─────────────────────────┘                  │   agent.php           │
                                                                         │  WordPress            │
                                                                         └───────────────────────┘
```

| Part                            | What it is                                                                                             | Where it runs                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Claude Code (or Claude Desktop) | The chat you type into. It decides which tool to call.                                                 | Your computer                      |
| auto-wp MCP server              | Does the real work: backups, checks, updates, reports.                                                 | VPS (recommended) or your computer |
| Transport                       | How the server reaches a site: SSH + WP-CLI, or the signed PHP agent over HTTPS.                       | Between server and site            |
| PHP agent                       | A small standalone `agent.php` for hosts with no SSH. It does not load WordPress for its core actions. | The client's cPanel account        |

## Two ways to reach a site

| Transport                          | Needs                                                      | Use it when                                                       |
| ---------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| **Agent** (recommended for cPanel) | HTTPS on the site, PHP 7.4 to 8.4, one cron job to install | The host has no SSH, or you want the simplest setup               |
| **SSH + WP-CLI**                   | SSH access and PHP CLI                                     | The host offers SSH and you prefer to install nothing on the site |

See [Choose your setup](/guide/choose-setup) to pick one.

## Why the server runs outside WordPress

A maintenance tool that lives inside WordPress fails at the worst moment.
1. **It breaks with the site.** If an update causes a fatal error, a plugin-based tool goes down with it and cannot roll back.
2. **It updates itself.** It would be changing the code it runs on, under PHP's time and memory limits.
3. **It adds an attack surface.** An admin-level endpoint inside WordPress is exposed to every other plugin on the site.
4. **It cannot judge independently.** It cannot take outside screenshots, and it would judge its own backups.

Because auto-wp runs elsewhere, it can still see the broken site, roll back and tell you what happened. The full reasoning is in [ADR-001](/ADR-001-architecture). The agent's wire format is in the [agent protocol](/agent-protocol).

::: tip No WordPress passwords
auto-wp never stores WordPress admin passwords and does not need them.
:::

## Next steps

- [How it works](/guide/how-it-works): the flow of one maintenance run.
- [Choose your setup](/guide/choose-setup).

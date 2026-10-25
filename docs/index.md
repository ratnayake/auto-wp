---
layout: home
title: auto-wp
hero:
  name: auto-wp
  text: Safe WordPress maintenance, run by your AI assistant
  tagline: Verified backups, one-by-one updates with automatic rollback, and a clear report. Built for sites on shared hosting.
  actions:
    - theme: brand
      text: Choose your setup
      link: /guide/choose-setup
    - theme: alt
      text: Try it locally
      link: /guide/quick-start
    - theme: alt
      text: Recommended setup
      link: /deploy/docker-vps
features:
  - icon: 🛡️
    title: Runs outside WordPress
    details: auto-wp lives on your VPS or computer, not inside a plugin. If an update breaks the site, the tool that fixes it is still alive.
    link: /guide/what-is-auto-wp
    linkText: Why this matters
  - icon: 💾
    title: Verified backups
    details: Every run starts with a full backup that is checked (checksums, archive and SQL checks) before anything changes.
    link: /guide/how-it-works
    linkText: See the flow
  - icon: 🔁
    title: One-by-one updates with rollback
    details: Each core, theme and plugin update gets a health check. A failing update is rolled back from its own snapshot.
    link: /guide/how-it-works#per-item-rollback
    linkText: How rollback works
  - icon: 🔎
    title: Vulnerability report
    details: The report lists old and new versions and the known vulnerabilities, and says whether the update fixes each one.
    link: /usage/reports
    linkText: See a report
  - icon: 🔌
    title: Works without SSH
    details: No SSH on your cPanel plan? A small signed PHP agent, installed with a one-off cron job, does the work over HTTPS.
    link: /sites/cpanel-no-ssh
    linkText: cPanel without SSH
  - icon: ✋
    title: Human approval for risky steps
    details: Restores, backup pruning and major core updates always wait for you to confirm. They never run on their own.
    link: /help/security-checklist
    linkText: Safety rules
---

## Choose your setup

Most people use the first path. Pick one and follow it from top to bottom.

| Path                                                       | Best for                                              | Start here                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Recommended:** Docker on a VPS, cPanel sites without SSH | Managing several client sites from your own computer. | [Docker on a VPS](/deploy/docker-vps), then [cPanel without SSH](/sites/cpanel-no-ssh) |
| Local on your computer, sites with SSH                     | One or two sites, or a first test with real sites.    | [Local (stdio)](/deploy/local-stdio), then [cPanel with SSH](/sites/cpanel-ssh)        |
| systemd on a VPS, no Docker                                | You prefer plain Linux services.                      | [systemd on a VPS](/deploy/systemd-vps)                                                |

Not sure? Read [Choose your setup](/guide/choose-setup). Want to see it work first? Try the [quick start](/guide/quick-start), which needs no real site.

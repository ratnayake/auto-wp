# Quick start

In this page you try auto-wp on your computer without touching a real site, in about 10 minutes (plus about 7 minutes for the first Docker download if you run the full harness).

You have two options. Start with the first: it is the fastest.

## Option A: fake mode (2 minutes)

`AUTOWP_FAKE=1` swaps every service for a stand-in. Nothing reaches any site, and backups and verification are stubs. Use it to see the tools and the conversation flow.
1. Install the code (see [Install](/guide/install)).
2. Add the server to Claude Code with fake mode on:

   ```sh
   claude mcp add auto-wp -e AUTOWP_FAKE=1 -- node /path/to/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --stdio
   claude mcp list
   ```

   Replace `/path/to/auto-wp` with your checkout.
3. Ask Claude: "List my auto-wp sites." You get one demo site with the id `demo`.
4. Ask Claude: "Run a maintenance pass on demo, with a backup, a dry run and a report."

::: warning Fake mode is loud on purpose
The server logs `AUTOWP_FAKE=1: FAKE SERVICES IN USE` at start-up. Remove the server (`claude mcp remove auto-wp`) before you add the real one.
:::

## Option B: the Docker e2e harness (about 10 minutes)

The harness starts two throwaway WordPress sites in Docker and drives the whole flow against them. One site is reached over SSH, the other through the agent. It is the closest thing to a real run.

You need Docker, `ssh`, `ssh-keygen`, `python3`, and network access (it downloads WordPress).
1. From your checkout, start the sites:

   ```sh
   e2e/scripts/up.sh
   ```

   The first start downloads images and WordPress and takes about 7 minutes.
2. Run the scenarios:

   ```sh
   AUTOWP_E2E_REAL=1 AUTOWP_E2E=1 pnpm e2e
   ```

3. Remove everything when you are done:

   ```sh
   e2e/scripts/down.sh
   ```

   `down.sh` removes the containers and volumes.

The scenarios cover the whole flow: probe, protected backup, verify (and a tampered copy failing), update check with mock vulnerabilities, a dry run, a real apply where a deliberately broken plugin is rolled back, the report, a database restore, a full restore, and the audit log. The details are in the [e2e README](https://github.com/ratnayake/auto-wp/blob/main/e2e/README.md).

::: tip Unit tests never use Docker
`pnpm test` runs all unit tests and never starts Docker. The e2e tests skip unless `AUTOWP_E2E=1`.
:::

## Next steps

- [Choose your setup](/guide/choose-setup) for a real site.
- [Install](/guide/install) the prerequisites.

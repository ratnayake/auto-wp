# Install

In this page you install what auto-wp needs and get the code onto the machine that runs the server.

::: tip Using Docker on a VPS?
The Docker image installs Node.js and pnpm for you. Skip to [Docker on a VPS](/deploy/docker-vps). You only need Docker there.
:::

## Prerequisites

On the machine that runs auto-wp (your computer or the VPS):

| Need                                           | Why                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24 or newer (`engines.node` is `>=24`) | Runs the server.                                                                                                                                                                         |
| pnpm 11 (`packageManager` is `pnpm@11.20.0`)   | Installs dependencies.                                                                                                                                                                   |
| Docker                                         | For the local e2e harness, and for `backup_verify` with `deep=true`. The deep check restores the backup into a throwaway MariaDB container. Without Docker it is skipped with a warning. |
| `ssh`, `ssh-keygen`, `ssh-keyscan`             | Only for the SSH setup.                                                                                                                                                                  |

On each WordPress site, one of:
- **Agent transport:** PHP 7.4 to 8.4 served over HTTPS. No SSH needed.
- **SSH transport:** SSH access and PHP CLI. auto-wp uploads `agent.php` and `wp-cli.phar` into `toolDir` (default `~/.auto-wp`).

On your computer: Claude Code or Claude Desktop.

## Get the code

1. Clone the repository and install the dependencies:

   ```sh
   git clone https://github.com/ratnayake/auto-wp.git
   cd auto-wp
   pnpm install
   ```

2. Run the unit tests:

   ```sh
   pnpm test
   ```

   They never start Docker.

3. Check that the server starts:

   ```sh
   node apps/mcp-server/bin/auto-wp-mcp.mjs --help
   ```

   The server runs the TypeScript source through `tsx`, so there is no build step.

## Read these docs offline

The documentation site is part of the repository.

```sh
pnpm docs:dev
```

Open the address it prints. `pnpm docs:build` makes a static copy.

## Next steps

- [Quick start](/guide/quick-start): try it without a real site.
- [Choose your setup](/guide/choose-setup).

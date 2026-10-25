# Local (stdio)

In this page you run auto-wp on your own computer and connect Claude Code or Claude Desktop to it over stdio, with no network exposure.

stdio means Claude starts the server as a child process and talks to it through stdin and stdout. Logs go to stderr, because stdout is the MCP channel.

## 1. Install and write a config

1. [Install](/guide/install) the prerequisites and the code.
2. Create the config folder, private to you:

   ```sh
   mkdir -p ~/.config/auto-wp
   chmod 700 ~/.config/auto-wp
   ```

3. Write `~/.config/auto-wp/config.yaml`. Use the examples in [Configuration](/sites/configuration), or add a site with [cPanel without SSH](/sites/cpanel-no-ssh) or [cPanel with SSH](/sites/cpanel-ssh).

## 2. Make a launcher for secrets

Keep secrets off the command line. A small launcher reads them from a private file:

```sh
install -m 700 /dev/null ~/.config/auto-wp/run.sh
cat > ~/.config/auto-wp/run.sh <<'SH'
#!/bin/sh
# Loads secrets from files, then starts the server on stdio.
AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY="$(cat "$HOME/.config/auto-wp/example-agent.seed")"
export AUTOWP_SECRET_EXAMPLE_AGENT_SIGNING_KEY
export AUTOWP_CONFIG="$HOME/.config/auto-wp/config.yaml"
exec node /path/to/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --stdio
SH
```

Replace `/path/to/auto-wp` with your checkout. For SSH sites, make sure `SSH_AUTH_SOCK` is set in the environment that starts Claude (see [cPanel with SSH](/sites/cpanel-ssh)).

## 3. Add it to Claude

::: code-group

```sh [Claude Code CLI]
claude mcp add auto-wp -- ~/.config/auto-wp/run.sh
claude mcp list
```

```json [Claude Desktop]
{
  "mcpServers": {
    "auto-wp": {
      "command": "/home/USER/.config/auto-wp/run.sh",
      "args": []
    }
  }
}
```

:::

The Claude Desktop file is `claude_desktop_config.json`.

If you have no secrets in env vars (an SSH-only setup), you can call node directly:

```sh
claude mcp add auto-wp -e AUTOWP_CONFIG=/home/USER/.config/auto-wp/config.yaml -- node /path/to/auto-wp/apps/mcp-server/bin/auto-wp-mcp.mjs --stdio
```

## 4. Check it

Ask Claude: "List my auto-wp sites, then probe each one." See [Your first maintenance run](/usage/first-run).

::: warning Approvals under stdio
Gated actions ask through MCP elicitation. The terminal fallback works only when the server's own stdin is a terminal, which is not the case under stdio. If your Claude client cannot show the prompt, the action is refused.
:::

::: tip Your IP changes
At home, your IP can change, so skip `--allow-ip` on the agent or use a VPS instead. See [Docker on a VPS](/deploy/docker-vps).
:::

## Next steps

- [Connect a site](/guide/choose-setup).
- [Your first maintenance run](/usage/first-run).

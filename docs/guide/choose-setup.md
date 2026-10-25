# Choose your setup

In this page you pick the setup that fits your hosting and your habits, using two short questions.

## Question 1: how do you reach each site?

| Your hosting                                         | Use                                        | Guide                                            |
| ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| cPanel, **no SSH** (or no Terminal)                  | PHP agent, installed by a one-off cron job | [cPanel without SSH](/sites/cpanel-no-ssh)       |
| cPanel, **with SSH**                                 | SSH + WP-CLI                               | [cPanel with SSH](/sites/cpanel-ssh)             |
| Another host with SSH                                | SSH + WP-CLI                               | [Any host with SSH](/sites/ssh-generic)          |
| SSH, but you can run PHP by hand (or no cPanel cron) | Agent, installed manually                  | [Install the agent by hand](/sites/agent-manual) |

::: tip Not sure which one?
Choose the agent. It works on every host that serves HTTPS, and it keeps all secrets on your server.
:::

## Question 2: where does the server run?

| Option                             | Pros                                                                                                             | Cons                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Docker on a VPS** (recommended)  | Always on. One static IP for allowlisting. Locked-down container. Easy updates. Claude Code connects over HTTPS. | Needs a VPS and a domain name.                                                              |
| **Local (stdio) on your computer** | Nothing to host. Best for a first real test.                                                                     | Your computer's IP changes, so IP allowlists are hard. Runs only while your computer is on. |
| **systemd on a VPS**               | No Docker. Fine-grained systemd hardening.                                                                       | More manual setup.                                                                          |

## The decision table

| Sites  | Server           | Result                                                                                                              |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| No SSH | Docker on a VPS  | **Recommended.** [Docker on a VPS](/deploy/docker-vps) and [cPanel without SSH](/sites/cpanel-no-ssh).              |
| No SSH | Local            | Works. Skip `--allow-ip` or use your home IP. See [Local (stdio)](/deploy/local-stdio).                             |
| SSH    | Docker on a VPS  | Works. You must put the SSH key in an ssh-agent the container can reach, which is more work. Prefer the agent here. |
| SSH    | Local            | Simple. [Local (stdio)](/deploy/local-stdio) and [cPanel with SSH](/sites/cpanel-ssh).                              |
| SSH    | systemd on a VPS | [systemd on a VPS](/deploy/systemd-vps), including the ssh-agent setup.                                             |

::: warning SSH sites in Docker
The Docker deployment in this repo is built for agent sites. Its compose file does not mount an ssh-agent socket. If you need SSH sites on a VPS, use [systemd on a VPS](/deploy/systemd-vps).
:::

## You will always need

- Claude Code (or Claude Desktop) on your computer.
- Node.js 24 and pnpm 11 wherever the server runs without Docker. See [Install](/guide/install).
- A backup plan for the server's own data. See [Docker on a VPS](/deploy/docker-vps#operations).

## Next steps

- Want to see it work first? [Quick start](/guide/quick-start).
- Ready to build? [Install](/guide/install).

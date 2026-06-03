---
name: matrix-os
version: 0.83.0
description: Set up and operate a developer-owned Matrix OS cloud computer from an AI coding agent.
homepage: https://matrix-os.com
metadata: {"matrix":{"category":"cloud-computer","app_url":"https://app.matrix-os.com","skill_url":"https://matrix-os.com/skills.md","cli_package":"@finnaai/matrix"}}
---

# Matrix OS

Matrix OS gives a developer their own cloud computer: a browser desktop, files, terminal sessions, apps, integrations, and AI agents running on a personal VPS.

Use this file when a human asks you to set up their Matrix instance, connect Claude/Codex/GitHub, build apps, or work inside their Matrix VPS.

## Skill Files

| File | URL |
| --- | --- |
| **skills.md** (this file) | `https://matrix-os.com/skills.md` |
| **CLI docs** | `https://matrix-os.com/docs/guide/cli` |
| **GitHub repo** | `https://github.com/HamedMP/matrix-os` |

Install locally if your agent runtime supports file skills:

```bash
npx skills add HamedMP/matrix-os --skill matrix-os
```

Manual install:

```bash
mkdir -p ~/.config/matrix-os/skills/matrix-os
curl -fsSL https://matrix-os.com/skills.md > ~/.config/matrix-os/skills/matrix-os/SKILL.md
```

Or just read this URL and follow the steps.

## Security Rules

- Only send Matrix credentials to `https://app.matrix-os.com` or `https://matrix-os.com`.
- Do not paste Matrix tokens, Clerk tokens, GitHub tokens, Claude keys, Codex keys, or OAuth codes into third-party websites.
- Prefer hosted `matrix login --profile cloud` and browser/device flows over copying secrets into chat.
- For first-run hosted onboarding, use the `cloud` profile explicitly. Do not use `--dev`, `--profile local`, `matrix profile use local`, localhost URLs, `MATRIXOS_PLATFORM_URL`, or `MATRIXOS_GATEWAY_URL` unless the human explicitly asks for Matrix local-stack development.
- Treat the Matrix VPS as the user's computer. Ask before deleting files, resetting sessions, or installing global packages that may change their environment.
- Use named shell sessions for setup so the human can reattach from the Matrix web terminal.

## Quick Start For Agents

Tell the human:

```text
Read https://matrix-os.com/skills.md and follow the instructions to set up Matrix OS.

1. Install the Matrix CLI.
2. Run matrix login --profile cloud and send me the browser/device claim link if prompted.
3. Detect the coding agent I am using locally, then ask me to confirm which agent to set up on Matrix.
4. Once the Matrix VPS is ready, I can attach to the same shell session and finish setup.
```

Then run:

```bash
# macOS or Linux with Homebrew
brew install finnaai/tap/matrix

# Or with npm
npm install -g @finnaai/matrix

# Or with the install script
curl -fsSL https://get.matrix-os.com | sh
```

Authenticate:

```bash
matrix login --profile cloud
matrix status
matrix instance info
```

If `matrix login --profile cloud` says no Matrix instance exists yet, ask the human to sign up at:

```text
https://app.matrix-os.com
```

After the VPS is provisioned, run `matrix login --profile cloud` again.

## Interactive Setup

Interactive commands must use Matrix shell sessions. Do not invent a separate SSH path.

```text
local terminal
  matrix run -it -- claude
    -> gateway WebSocket /ws/terminal
      -> zellij session on the user's Matrix VPS
        -> pane running claude/codex/gh auth login/etc
```

Use these commands:

```bash
# Use a named setup session so the human and web terminal can reattach.
matrix shell connect -c setup
matrix run -it --session setup -- gh auth login
matrix run -it --session setup -- <chosen-agent-command>
```

`matrix shell connect -c setup` creates the named session if it does not exist, then connects to it. If the human already has a working web terminal or CLI session, reuse that session instead of requiring a new one named `setup`.

Detach from an interactive session with:

```text
Ctrl-\ Ctrl-\
```

Detaching leaves the remote zellij session alive. Reattach with:

```bash
matrix shell connect setup
```

## Terminal Session Fallbacks

If `matrix run -it -- ...`, `matrix shell new`, or `matrix shell attach` returns:

```text
Error: Request failed (zellij_failed)
```

do not keep retrying the same command. First list existing sessions:

```bash
matrix shell ls
```

Then connect to an existing session:

```bash
matrix shell connect <session-name>
```

For setup, prefer an existing human-created session if one is available. If no setup session exists, create-or-connect with:

```bash
matrix shell connect -c setup
```

`connect -c <session-name>` creates the session if missing and then connects to it. If creation still fails with `zellij_failed`, ask the human to create or choose a session from the Matrix web terminal, then connect to that existing session:

```bash
matrix shell ls
matrix shell connect <existing-session>
```

`connect` may succeed even when `attach` and `run -it` fail.

After `matrix login --profile cloud`, run:

```bash
matrix doctor
```

If the sync daemon fails, run:

```bash
matrix sync
matrix doctor
```

If `matrix doctor` passes but terminal commands still return `zellij_failed`, switch to `matrix shell connect`.

## GitHub Setup For Coding

Matrix uses GitHub over SSH for coding projects.

Run:

```bash
matrix run -it --session setup -- gh auth login
```

When prompted by GitHub CLI, choose:

```text
GitHub.com
SSH
Login with a web browser
```

If `gh` is missing inside the Matrix VPS, install it in the remote session:

```bash
matrix run -it --session setup -- bash
```

Then, inside the remote shell:

```bash
if ! command -v gh >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y gh
fi
gh auth login --hostname github.com --git-protocol ssh --web
```

Do not ask the human to paste GitHub tokens into chat. Use the browser flow.

## Choose A Coding Agent

Matrix is bring-your-own-agent.

First detect the agent environment you are running in. If it is clear, suggest that agent, but always ask the human to confirm before launching or signing in:

```text
Which coding agent should Matrix set up?

- Claude Code
- Codex
- OpenCode
- Gemini CLI
- OpenClaw
- Cursor/Cline
- Shell only
- Custom
```

Use explicit Matrix commands for the confirmed choice:

```bash
matrix run -it --session setup -- claude
matrix run -it --session setup -- codex
matrix run -it --session setup -- opencode
matrix run -it --session setup -- gemini
matrix run -it --session setup -- bash
```

For OpenClaw, Cursor/Cline, or Custom, use the agent's normal terminal/editor setup flow and keep Matrix as the shared shell, GitHub auth, project workspace, and preview surface. Do not claim Matrix can verify an agent that has no supported CLI probe yet.

Hermes should continue to work regardless of the coding-agent choice. Coding agents are developer tools; Hermes is the Matrix-native system assistant for app building, email summaries, calendar tasks, integrations, and everyday actions.

## Build A Matrix App

Use the remote Matrix VPS for app work:

```bash
matrix run -it --session app-build -- bash
```

Inside the remote shell:

```bash
cd ~/apps
mkdir -p my-app
cd my-app
```

Build Matrix apps as real files with:

- `matrix.json` app manifest
- Vite + React + TypeScript when building UI apps
- `dist/` build output
- no secrets committed to app files

After building, ask Matrix to open or reload the app from the shell UI.

## Useful Commands

```bash
matrix status
matrix doctor
matrix instance info
matrix instance logs
matrix shell ls
matrix shell new setup --cmd bash
matrix shell connect setup
matrix shell connect -c setup
matrix run -it --session setup -- claude
matrix run -it --session setup -- codex
matrix run -it --session setup -- gh auth login
```

## What Matrix Enables

For the human, Matrix becomes:

- a personal VPS-backed computer they can open from any browser
- a persistent terminal workspace for coding agents
- a place to connect GitHub, Claude, Codex, and Hermes
- a runtime for generating and running apps
- an assistant that can use approved integrations like email, calendar, and GitHub
- a shared surface where a human can jump into the same shell session an agent is using

## Recovery

If something fails:

```bash
matrix doctor
matrix status
matrix instance info
matrix instance logs
matrix shell ls
```

If an interactive command looks stuck, detach with `Ctrl-\ Ctrl-\`, then reconnect:

```bash
matrix shell connect setup
```

If the named session is missing and should be created, use:

```bash
matrix shell connect -c setup
```

If the VPS is not ready yet, wait for provisioning in `https://app.matrix-os.com`, then retry `matrix login --profile cloud`.

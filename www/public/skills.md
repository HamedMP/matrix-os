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
- If the human wants to reuse local AI-agent credentials, use Matrix CLI transfer commands only. Do not read, print, summarize, or paste credential file contents into chat.
- Treat the Matrix VPS as the user's computer. Ask before deleting files, resetting sessions, or installing global packages that may change their environment.
- Use named shell sessions for setup so the human can reattach from the Matrix web terminal.

## Quick Start For Agents

Tell the human:

```text
Read https://matrix-os.com/skills.md and follow the instructions to set up Matrix OS.

1. Install the Matrix CLI.
2. Run matrix login --profile cloud and send me the browser/device claim link if prompted.
3. Once the Matrix VPS is ready, I can attach to the same shell session and finish setup.
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
matrix agent auth scan
```

If `matrix login --profile cloud` says no Matrix instance exists yet, ask the human to sign up at:

```text
https://app.matrix-os.com
```

After the VPS is provisioned, run `matrix login --profile cloud` again.

## Agent Credential Setup

After `matrix agent auth scan`, ask the human which found credentials they want copied to the Matrix VPS. Only run the matching command after they approve:

```bash
matrix upload --secret ~/.codex/auth.json .codex/auth.json
matrix upload --secret ~/.claude/.credentials.json .claude/.credentials.json
matrix upload --secret ~/.local/share/opencode/auth.json .local/share/opencode/auth.json
matrix upload --secret ~/.pi/agent/auth.json .pi/agent/auth.json
```

These commands transfer files through Matrix CLI without exposing token contents to the agent transcript. If Claude Code is logged in only through macOS Keychain, do not try to extract it; launch Claude once on the Matrix VPS and let the human complete the remote login flow.

## Interactive Setup

Interactive commands must use Matrix shell sessions. Do not invent a separate SSH path.

```text
local terminal
  matrix run -it --session setup -- claude
    -> gateway WebSocket /ws/terminal
      -> zellij session on the user's Matrix VPS
        -> pane running the selected agent
```

Use these commands:

```bash
# Use a named setup session so the human and web terminal can reattach.
mos shell attach -c setup
matrix run -it --session setup -- gh auth login
matrix run -it --session setup -- claude
matrix run -it --session setup -- codex
```

Run either Claude or Codex according to the human's choice; do not start both unless the human explicitly asks.

`mos shell attach -c setup` creates the named session if it does not exist, then attaches to it. If the human already has a working web terminal or CLI session, reuse that session instead of requiring a new one named `setup`.

Detach from an interactive session with:

```text
Ctrl-\ Ctrl-\
```

Detaching leaves the remote zellij session alive. Reattach with:

```bash
mos shell attach setup
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
mos shell attach <session-name>
```

For setup, prefer an existing human-created session if one is available. If no setup session exists, create-or-connect with:

```bash
mos shell attach -c setup
```

`attach -c <session-name>` creates the session if missing and then attaches to it. If creation still fails with `zellij_failed`, ask the human to create or choose a session from the Matrix web terminal, then attach to that existing session:

```bash
matrix shell ls
mos shell attach <existing-session>
```

`attach` may succeed even when `run -it` fails.

After `matrix login --profile cloud`, run:

```bash
matrix doctor
```

If the sync daemon fails, run:

```bash
matrix sync
matrix doctor
```

If `matrix doctor` passes but terminal commands still return `zellij_failed`, switch to `mos shell attach`.

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

## Claude, Codex, And Hermes

Matrix is bring-your-own-agent.

Preferred setup order:

1. If the human uses Claude, run `matrix run -it --session setup -- claude` and complete Claude login in the remote terminal.
2. If the human uses Codex, run `matrix run -it --session setup -- codex` and complete Codex login in the remote terminal.
3. If neither Claude nor Codex is available, use Hermes inside Matrix as the system agent for building apps and completing tasks.

Hermes should continue to work even when Claude or Codex are connected. Claude/Codex are developer tools; Hermes is the Matrix-native assistant for app building, email summaries, calendar tasks, integrations, and everyday actions.

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
matrix agent auth scan
matrix shell ls
matrix shell new setup --cmd bash
mos shell attach setup
mos shell attach -c setup
matrix upload --secret ~/.codex/auth.json .codex/auth.json
matrix upload --secret ~/.claude/.credentials.json .claude/.credentials.json
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
mos shell attach setup
```

If the named session is missing and should be created, use:

```bash
mos shell attach -c setup
```

If the VPS is not ready yet, wait for provisioning in `https://app.matrix-os.com`, then retry `matrix login --profile cloud`.

---
name: matrix-os
description: Set up and operate a developer-owned Matrix OS cloud computer from an AI coding agent, including CLI login, VPS setup, GitHub auth, Claude/Codex sessions, Hermes fallback, and shared zellij shell connect.
version: 0.84.0
author: Matrix OS
license: AGPL-3.0-or-later
metadata:
  matrix:
    homepage: https://matrix-os.com
    skill_url: https://matrix-os.com/skills.md
    app_url: https://app.matrix-os.com
    cli_package: "@finnaai/matrix"
  agent:
    tags: [Matrix OS, cloud computer, VPS, CLI, zellij, Claude, Codex, Hermes, GitHub]
    related_skills: [matrix-dev-vps, matrix-app-builder, matrix-integrations, matrix-debug-app]
---

# Matrix OS

Use this skill when a human asks you to set up Matrix OS, connect a developer agent, configure GitHub, build Matrix apps, or work inside their Matrix VPS.

Matrix OS gives each developer their own cloud computer: browser desktop, files, terminal sessions, apps, integrations, and AI agents running on a personal VPS.

## Security Rules

- Only send Matrix credentials to `https://app.matrix-os.com` or `https://matrix-os.com`.
- Do not paste Matrix tokens, Clerk tokens, GitHub tokens, Claude keys, Codex keys, or OAuth codes into third-party websites.
- Prefer hosted `matrix login --profile cloud` and browser/device flows over copying secrets into chat.
- For first-run hosted onboarding, use the `cloud` profile explicitly. Do not use `--dev`, `--profile local`, `matrix profile use local`, localhost URLs, `MATRIXOS_PLATFORM_URL`, or `MATRIXOS_GATEWAY_URL` unless the human explicitly asks for Matrix local-stack development.
- If the human wants to reuse local AI-agent credentials or settings, use Matrix CLI transfer commands only. Do not read, print, summarize, or paste credential file contents into chat.
- Treat the Matrix VPS as the user's computer. Ask before deleting files, resetting sessions, or installing global packages that may change their environment.
- Use named shell sessions for setup so the human can reattach from the Matrix web terminal.

## Install Or Read

If the human wants a local agent skill install:

```bash
npx skills add HamedMP/matrix-os --skill matrix-os
```

If the agent can read remote URLs directly:

```text
Read https://matrix-os.com/skills.md and follow the instructions to set up Matrix OS.
```

## Quick Start

Tell the human:

```text
Read https://matrix-os.com/skills.md and follow the instructions to set up Matrix OS.

1. Install the Matrix CLI.
2. Run matrix login --profile cloud and send me the browser/device claim link if prompted.
3. I will verify the gateway with matrix doctor, scan for local AI-agent settings, copy only approved credential files, ask you to run gh auth login inside Matrix, and start your preferred coding agent with matrix run.
```

Then run:

```bash
brew install finnaai/tap/matrix
# or
npm install -g @finnaai/matrix
# or
curl -fsSL https://get.matrix-os.com | sh
```

Authenticate:

```bash
matrix login --profile cloud
matrix doctor
matrix whoami
matrix status
matrix instance info
matrix agent auth scan
```

If `matrix login --profile cloud` says no Matrix instance exists yet, ask the human to sign up at `https://app.matrix-os.com`, wait for provisioning, then run `matrix login --profile cloud` again.

## Agent Credential And Settings Transfer

After `matrix agent auth scan`, ask which found credentials or settings the human wants copied to the Matrix VPS. Only run the matching command after explicit approval:

```bash
matrix upload --secret ~/.codex/auth.json .codex/auth.json
matrix upload --secret ~/.claude/.credentials.json .claude/.credentials.json
matrix upload --secret ~/.local/share/opencode/auth.json .local/share/opencode/auth.json
matrix upload --secret ~/.pi/agent/auth.json .pi/agent/auth.json
```

These commands transfer files through the Matrix CLI without exposing token contents to the transcript. If a provider is reported as `manual`, do not improvise token extraction. For example, Claude Code credentials stored only in macOS Keychain require launching Claude in Matrix and letting the human complete the remote login flow.

Treat non-secret local settings as opt-in too. If the human asks to copy a config file, use `matrix upload` for ordinary settings and `matrix upload --secret` for anything that may contain tokens. Never print file contents.

## Interactive Setup

Interactive commands must use Matrix shell sessions. Do not create a separate SSH path.

```text
local terminal
  matrix run -it -- claude
    -> gateway WebSocket /ws/terminal
      -> zellij session on the user's Matrix VPS
        -> pane running claude/codex/gh auth login/etc
```

Use named sessions:

```bash
matrix run -it --session setup -- gh auth login
matrix run -it --session setup -- claude
matrix run -it --session setup -- codex
matrix shell connect setup
```

Detach with `Ctrl-\ Ctrl-\`. Detaching leaves the remote zellij session alive. Reattach with:

```bash
matrix shell connect setup
```

If a setup session does not exist, create or connect with:

```bash
matrix shell connect -c setup
```

Do not start both Claude and Codex unless the human explicitly asks. Pick the human's preferred coding agent.

## Terminal Session Fallbacks

If `matrix run -it -- ...`, `matrix shell new`, or `matrix shell connect` fails with `zellij_failed`, do not keep retrying the same command. First list sessions:

```bash
matrix shell ls
```

Then connect to an existing session:

```bash
matrix shell connect <session-name>
```

For setup, prefer an existing human-created session if one is available. If no setup session exists, use:

```bash
matrix shell connect -c setup
```

After `matrix login --profile cloud`, run:

```bash
matrix doctor
```

## GitHub Setup For Coding

Matrix uses GitHub over SSH for coding projects.

```bash
matrix run -it --session setup -- gh auth login
```

When prompted by GitHub CLI, choose:

```text
GitHub.com
SSH
Login with a web browser
```

If `gh` is missing inside the Matrix VPS:

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

Hermes must continue to work even when Claude or Codex are connected. Claude/Codex are developer tools; Hermes is the Matrix-native assistant for app building, email summaries, calendar tasks, integrations, and everyday actions.

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
matrix whoami
matrix instance info
matrix instance logs
matrix agent auth scan
matrix shell ls
matrix shell new setup --cmd bash
matrix shell connect setup
matrix shell connect -c setup
matrix upload --secret ~/.codex/auth.json .codex/auth.json
matrix upload --secret ~/.claude/.credentials.json .claude/.credentials.json
matrix run -it --session setup -- claude
matrix run -it --session setup -- codex
matrix run -it --session setup -- gh auth login
```

## Recovery

If something fails:

```bash
matrix doctor
matrix status
matrix instance info
matrix instance logs
matrix shell ls
```

If an interactive command looks stuck, detach with `Ctrl-\ Ctrl-\`, then reattach:

```bash
matrix shell connect setup
```

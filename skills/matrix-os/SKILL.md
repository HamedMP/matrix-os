---
name: matrix-os
description: Set up and operate a Matrix OS cloud computer from a local AI agent using observable named sessions. Use for Matrix CLI login and recovery, in-VPS Codex or Claude authentication, remote commands, Matrix app creation, and collision-safe GitHub repository changes.
author: Matrix OS
license: AGPL-3.0-or-later
metadata:
  matrix:
    homepage: https://matrix-os.com
    skill_url: https://matrix-os.com/skills.md
    app_url: https://app.matrix-os.com
    cli_package: "@finnaai/matrix"
---

# Matrix OS

Control the user's Matrix cloud computer through the existing Matrix CLI. Keep credentials on the service that owns them and preserve all remote work by default.

## Security, sessions, and readiness

- Use the hosted `cloud` profile unless the user explicitly requests local Matrix development.
- Use browser/device authentication inside Matrix. Never scan, read, or transfer local credential files as part of setup.
- Never request tokens, API keys, OAuth codes, or secret contents in chat.
- Ask before deleting files, resetting auth, or installing global tools. Prefer Matrix's visible developer-tool picker or install action.
- Always run remote work with `matrix run -it --session <session-name> ... -- <argv...>`.
- Never create or use shell tabs. Create a separate uniquely named session for every additional command, terminal, or concurrent task.
- Report every session name and its `matrix shell connect <session-name>` command.
- Pass commands and prompts as argv after `--`; never interpolate user input into a shell string.
- Do not invent endpoints, SSH paths, persistence, or detached-job APIs.

Run this local gate before remote tasks:

```bash
matrix --version
matrix profile show cloud
matrix doctor
matrix whoami
matrix status
matrix instance info --json
```

If `matrix instance info` reports `ready: true` with `source: execution_probe`, continue and report that the management plane is degraded. Stop only when both management and execution checks fail.

If login is missing or expired, run `matrix login --profile cloud` and let the user finish browser/device authentication. If the account has no ready computer, direct the user to `https://app.matrix-os.com`, wait for provisioning, then repeat the gate.

Check only the selected agent, in separate observable sessions:

```bash
matrix run -it --session readiness-codex-<suffix> -- codex --version
matrix run -it --session readiness-codex-auth-<suffix> -- codex login status
```

or:

```bash
matrix run -it --session readiness-claude-<suffix> -- claude --version
matrix run -it --session readiness-claude-auth-<suffix> -- claude auth status
```

Authenticate in `auth-codex-<suffix>` or `auth-claude-<suffix>`, then repeat the status check in a new session. If a tool is missing, ask before a global install and use Matrix's visible developer-tool path when available.

For GitHub work, authenticate on Matrix:

```bash
matrix run -it --session readiness-github-<suffix> -- gh auth status
matrix run -it --session auth-github-<suffix> -- gh auth login --hostname github.com --git-protocol ssh --web
matrix shell connect auth-github-<suffix>
```

## Run commands and coding work

Normalize every requested directory to a safe relative path under the Matrix home. Reject empty or absolute paths, backslashes, control characters, and `.` or `..` segments. Inspect an existing destination before using it.

Use `projects/<name>` for ordinary work. For a new Matrix app, validate the slug and create the destination before selecting it:

```bash
matrix run -it --session create-app-<slug>-<suffix> -- mkdir -p -- apps/<slug>
matrix run -it --session verify-app-<slug>-<suffix> -C apps/<slug> -- pwd
```

`-C` selects an existing directory and never creates it.

Create a unique named session for every command:

```bash
matrix run -it --session <session-name> -C <dir> -- <argv...>
matrix shell connect <session-name>
```

Observe the session through completion and report the actual exit, timeout, disconnect, or truncated-output result. Never infer success from partial output.

Use Codex read-only mode for inspection and narrow workspace-write mode for changes:

```bash
matrix run -it --session inspect-codex-<suffix> -C <dir> -- codex --ask-for-approval never --sandbox read-only exec -- <prompt>
matrix run -it --session task-codex-<suffix> -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
```

Never use `danger-full-access` without explicit direction.

Run Claude without repetitive permission questions using its verified auto mode:

```bash
matrix run -it --session task-claude-<suffix> -C <dir> -- claude --permission-mode auto -p <prompt>
```

If Claude auto mode is unavailable, report that limitation and stop; do not fall back to a permission bypass.

## Work on GitHub repositories

Normalize the requested GitHub URL to an owner/repository pair. Default ordinary repositories to `projects/<repo>` and direct Matrix apps to `apps/<slug>`.

Inspect a destination in separate sessions. Stop on a non-Git collision. Reuse a checkout only when `git remote get-url origin` has the same normalized owner/repository as the request; stop on a mismatched origin rather than repointing it.

Clone an absent checkout through the authenticated remote GitHub CLI:

```bash
matrix run -it --session clone-<repo>-<suffix> -- gh repo clone <owner>/<repo> projects/<repo>
matrix shell connect clone-<repo>-<suffix>
```

Inspect branch and dirty state before fetching, switching, installing, launching an agent, or editing. Never reset, clean, stash, or overwrite user changes automatically. If a checkout is dirty or mid-operation, ask how the user wants to proceed.

For a clean task with no requested branch, resolve and fetch the remote default branch, then create `matrix/<task-slug>` from it without replacing an existing branch.

Read repository instructions, README files, lockfiles, task scripts, and environment examples before selecting install, development, build, and test commands. Apply the requested change and validate it in new purpose-specific sessions. Push or open a PR only when explicitly requested.

## Recovery and handoff

Use `matrix doctor`, `matrix status`, `matrix instance info --json`, and `matrix shell ls` to diagnose failures. Reattach named work with `matrix shell connect <session-name>`. Do not retry a `zellij_failed` create loop; reuse an existing session or ask the user to create a new uniquely named session in Matrix.

Report identity and readiness source, destination or checkout path, branch and initial dirty state, changed files, validation results, every session name, every reattach command, and whether anything was pushed.

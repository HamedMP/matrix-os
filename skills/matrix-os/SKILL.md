---
name: matrix-os
description: Set up and operate a Matrix OS cloud computer from a local AI agent using observable project-scoped terminal tabs. Use for Matrix CLI login and recovery, in-VPS Codex or Claude authentication, remote commands, Matrix app creation, and collision-safe GitHub repository changes.
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

## Security, terminal tabs, and readiness

- Use the hosted `cloud` profile unless the user explicitly requests local Matrix development.
- Use browser/device authentication inside Matrix. Never scan, read, or transfer local credential files as part of setup.
- Never request tokens, API keys, OAuth codes, or secret contents in chat.
- Ask before deleting files, resetting auth, or installing global tools. Prefer Matrix's visible developer-tool picker or install action.
- Always run remote work with `matrix run -it --project <project> ... -- <argv...>`; use `--project main` outside a known project.
- Each project owns one Zellij workspace. Create a separate Matrix tab for every additional command, terminal, or concurrent task.
- Report every returned tab ID and its `matrix shell connect --project <project> --tab <tab-id>` command.
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

Check only the selected agent, in separate observable tabs:

```bash
matrix run -it --project main -- codex --version
matrix run -it --project main -- codex login status
```

or:

```bash
matrix run -it --project main -- claude --version
matrix run -it --project main -- claude auth status
```

Authenticate in a new `main` tab, then repeat the status check in another tab. If a tool is missing, ask before a global install and use Matrix's visible developer-tool path when available.

For GitHub work, authenticate on Matrix:

```bash
matrix run -it --project main -- gh auth status
matrix run -it --project main -- gh auth login --hostname github.com --git-protocol ssh --web
matrix shell connect --project main --tab <tab-id>
```

## Run commands and coding work

Normalize every requested directory to a safe relative path under the Matrix home. Reject empty or absolute paths, backslashes, control characters, and `.` or `..` segments. Inspect an existing destination before using it.

Use `projects/<name>` for ordinary work. For a new Matrix app, validate the slug and create the destination before selecting it:

```bash
matrix run -it --project main -- mkdir -p -- apps/<slug>
matrix run -it --project main -C apps/<slug> -- pwd
```

`-C` selects an existing directory and never creates it.

Create a new tab for every command:

```bash
matrix run -it --project <project> -C <dir> -- <argv...>
matrix shell connect --project <project> --tab <tab-id>
```

Observe the session through completion and report the actual exit, timeout, disconnect, or truncated-output result. Never infer success from partial output.

Use Codex read-only mode for inspection and narrow workspace-write mode for changes:

```bash
matrix run -it --project <project> -C <dir> -- codex --ask-for-approval never --sandbox read-only exec -- <prompt>
matrix run -it --project <project> -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
```

Never use `danger-full-access` without explicit direction.

Run Claude without repetitive permission questions using its verified auto mode:

```bash
matrix run -it --project <project> -C <dir> -- claude --permission-mode auto -p <prompt>
```

If Claude auto mode is unavailable, report that limitation and stop; do not fall back to a permission bypass.

## Work on GitHub repositories

Normalize the requested GitHub URL to an owner/repository pair. Default ordinary repositories to `projects/<repo>` and direct Matrix apps to `apps/<slug>`.

Inspect a destination in separate tabs. Stop on a non-Git collision. Reuse a checkout only when `git remote get-url origin` has the same normalized owner/repository as the request; stop on a mismatched origin rather than repointing it.

Clone an absent checkout through the authenticated remote GitHub CLI:

```bash
matrix run -it --project main -- gh repo clone <owner>/<repo> projects/<repo>
matrix shell connect --project main --tab <tab-id>
```

Inspect branch and dirty state before fetching, switching, installing, launching an agent, or editing. Never reset, clean, stash, or overwrite user changes automatically. If a checkout is dirty or mid-operation, ask how the user wants to proceed.

For a clean task with no requested branch, resolve and fetch the remote default branch, then create `matrix/<task-slug>` from it without replacing an existing branch.

Read repository instructions, README files, lockfiles, task scripts, and environment examples before selecting install, development, build, and test commands. Apply the requested change and validate it in new purpose-specific sessions. Push or open a PR only when explicitly requested.

## Recovery and handoff

Use `matrix doctor`, `matrix status`, `matrix instance info --json`, and `matrix shell list` to diagnose failures. Reattach work with `matrix shell connect --project <project> --tab <tab-id>`. Do not retry a failed tab-create loop indefinitely; list the workspace and reconnect an existing tab or create another tab.

Report identity and readiness source, destination or checkout path, branch and initial dirty state, changed files, validation results, every terminal reference, every reconnect command, and whether anything was pushed.

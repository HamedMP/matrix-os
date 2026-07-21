---
name: matrix-os
description: Set up and operate a Matrix OS cloud computer from a local AI agent. Use for Matrix CLI login and recovery, in-VPS Codex or Claude authentication, bounded remote commands, Matrix app creation, and collision-safe GitHub repository changes.
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

## Security and readiness

- Use the hosted `cloud` profile unless the user explicitly requests local Matrix development.
- Use browser/device authentication inside Matrix. Never scan, read, or transfer local credential files as part of setup.
- Never request tokens, API keys, OAuth codes, or secret contents in chat.
- Ask before deleting files, resetting auth, or installing global tools. Prefer Matrix's visible developer-tool picker or install action.
- Do not invent endpoints, SSH paths, persistence, or detached-job APIs.

Run this gate before remote tasks:

```bash
matrix --version
matrix profile show cloud
matrix doctor
matrix whoami
matrix status
matrix instance info
```

If login is missing or expired, run `matrix login --profile cloud` and let the user finish browser/device authentication. If the account has no ready computer, direct the user to `https://app.matrix-os.com`, wait for provisioning, then repeat the gate.

Check only the selected agent:

```bash
matrix run --json -- codex --version
matrix run --json -- codex login status
```

or:

```bash
matrix run --json -- claude --version
matrix run --json -- claude auth status
```

Authenticate in a unique interactive session such as `auth-codex-<suffix>` or `auth-claude-<suffix>`, then repeat the status check. If a tool is missing, ask before a global install and use Matrix's visible developer-tool path when available.

For GitHub work, authenticate on Matrix:

```bash
matrix run --json -- gh auth status
matrix run -it --session auth-github-<suffix> -- gh auth login --hostname github.com --git-protocol ssh --web
```

## Run commands and coding work

Normalize every requested directory to a safe relative path under the Matrix home. Reject empty or absolute paths, backslashes, control characters, and `.` or `..` segments. Inspect an existing destination before using it.

Use `projects/<name>` for ordinary work. For a new Matrix app, validate the slug and create the destination before selecting it:

```bash
matrix run --json -- mkdir -p -- apps/<slug>
matrix run --json -C apps/<slug> -- pwd
```

`-C` selects an existing directory and never creates it.

For bounded commands, pass argv after `--`:

```bash
matrix run --json -C <dir> -- <argv...>
```

Inspect the JSON `exitCode`, `timedOut`, and `truncated` values. Report non-zero status, timeout, or partial output. Pass prompts as command arguments rather than shell-interpolated strings.

Use Codex read-only mode for inspection and narrow workspace-write mode for changes:

```bash
matrix run --json -C <dir> -- codex --ask-for-approval never --sandbox read-only exec -- <prompt>
matrix run --json -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
```

Never use `danger-full-access` without explicit direction. For work likely to exceed the one-shot timeout, use a unique `task-<slug>-<suffix>` session and report:

```bash
matrix run -it --session <session-name> -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
matrix shell connect <session-name>
```

Keep Claude supervised unless a sandboxed noninteractive invocation has been separately verified.

## Work on GitHub repositories

Normalize the requested GitHub URL to an owner/repository pair. Default ordinary repositories to `projects/<repo>` and direct Matrix apps to `apps/<slug>`.

Clone an absent checkout through the authenticated remote GitHub CLI:

```bash
matrix run --json -- gh repo clone <owner>/<repo> projects/<repo>
```

For an existing destination:

- Stop on a non-Git collision.
- Normalize `git remote get-url origin` and reuse the checkout only when owner/repository matches.
- Stop on a mismatched origin rather than repointing it.
- Inspect branch and dirty state before fetching, switching, installing, launching an agent, or editing.
- Never reset, clean, stash, or overwrite user changes automatically.

If a checkout is dirty or mid-operation, ask how the user wants to proceed. For a clean task with no requested branch, resolve and fetch the remote default branch, then create `matrix/<task-slug>` from it without replacing an existing branch.

Read repository instructions, README files, lockfiles, task scripts, and environment examples before selecting install, development, build, and test commands. Apply the requested change and validate it. Push or open a PR only when explicitly requested.

## Recovery and handoff

Use `matrix doctor`, `matrix status`, `matrix instance info`, and `matrix shell ls` to diagnose failures. Reattach named work with `matrix shell connect <session-name>`. Do not retry a `zellij_failed` create loop; reuse an existing session or ask the user to create one in Matrix.

Report identity and readiness, destination or checkout path, branch and initial dirty state, changed files, validation results, structured command outcome, session name, reattach command, and whether anything was pushed.

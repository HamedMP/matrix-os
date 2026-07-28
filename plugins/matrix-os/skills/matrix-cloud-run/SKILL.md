---
name: matrix-cloud-run
description: Run commands and coding-agent tasks in observable Matrix OS sessions. Use when a user asks to execute a command, inspect files, build a Matrix app, run validation, or perform coding work on a Matrix cloud computer.
---

# Run Work on Matrix OS

Execute every remote workflow in a uniquely named Matrix CLI session so the user can observe and reattach it.

## Session policy

- Always use `matrix run -it --session <session-name> ... -- <argv...>` for remote commands.
- Never create or use shell tabs. When another terminal or concurrent task is needed, create a separate uniquely named session.
- Use a short collision-resistant suffix in names such as `readiness-<suffix>`, `inspect-<slug>-<suffix>`, or `task-<slug>-<suffix>`.
- Report every session name and `matrix shell connect <session-name>` command immediately.
- Pass prompts as command arguments after `--`; never interpolate user input into `sh -c`, `bash -lc`, substitutions, or a single shell string.

## Minimal readiness gate

Verify the local CLI, hosted profile, login, identity, and instance:

```bash
matrix --version
matrix profile show cloud
matrix doctor
matrix whoami
matrix status
matrix instance info --json
```

If `matrix instance info` reports `ready: true` with `source: execution_probe`, continue and report that the management plane is degraded. Treat it as unavailable only when both management and execution checks fail.

If login is missing or expired, run `matrix login --profile cloud` and let the user complete browser/device authentication. If the instance is not provisioned, use `https://app.matrix-os.com` and wait until it is ready.

Check only the selected agent in a named readiness session:

```bash
matrix run -it --session readiness-codex-<suffix> -- codex --version
matrix run -it --session readiness-codex-auth-<suffix> -- codex login status
matrix run -it --session readiness-claude-<suffix> -- claude --version
matrix run -it --session readiness-claude-auth-<suffix> -- claude auth status
```

Run only the Codex pair or Claude pair. Authenticate a disconnected agent in `auth-codex-<suffix>` or `auth-claude-<suffix>`. Never scan, read, or upload local credential files. Ask before installing a missing global tool and prefer Matrix's visible developer-tool installation path.

## Validate the destination

- Normalize a safe relative destination under the Matrix home.
- Reject empty paths, absolute paths, backslashes, control characters, and `.` or `..` segments.
- Use `apps/<slug>` for a runnable Matrix app and `projects/<name>` for ordinary work.
- Inspect an existing destination before using it and stop on conflicting contents.

Use separate observable sessions for each probe:

```bash
matrix run -it --session inspect-exists-<suffix> -- test -e <dir>
matrix run -it --session inspect-type-<suffix> -- test -d <dir>
matrix run -it --session inspect-list-<suffix> -- ls -la <dir>
```

For a new app, create the normalized directory before selecting it:

```bash
matrix run -it --session create-app-<slug>-<suffix> -- mkdir -p -- apps/<slug>
matrix run -it --session verify-app-<slug>-<suffix> -C apps/<slug> -- pwd
```

`-C` selects an existing directory; it never creates it. Do not pass a nonexistent path to `matrix run -C`.

## Run tasks

Create a unique session for every command:

```bash
matrix run -it --session <session-name> -C <dir> -- <argv...>
matrix shell connect <session-name>
```

Observe the session through completion and report its actual command result. Never infer success from partial output or a disconnected local terminal.

For Codex inspection:

```bash
matrix run -it --session inspect-codex-<suffix> -C <dir> -- codex --ask-for-approval never --sandbox read-only exec -- <prompt>
```

For Codex changes:

```bash
matrix run -it --session task-codex-<suffix> -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
```

Pair unattended Codex with `--ask-for-approval never` and an explicit sandbox. Never use `danger-full-access` without explicit direction.

Run Claude without repetitive permission questions using its verified auto mode:

```bash
matrix run -it --session task-claude-<suffix> -C <dir> -- claude --permission-mode auto -p <prompt>
```

Auto mode keeps background safety checks while minimizing clarification and permission prompts. If the installed Claude version or account does not support auto mode, report that limitation and stop; do not fall back to a permission bypass.

## Handoff

Report the normalized destination, exact argv, validation performed, changed files, outcome, every session name, and every `matrix shell connect <session-name>` command.

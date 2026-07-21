---
name: matrix-cloud-run
description: Run bounded commands and coding-agent tasks on a Matrix OS cloud computer. Use when a user asks to execute a command, inspect files, build a new Matrix app, run validation, or perform longer coding work in a reattachable Matrix session.
---

# Run Work on Matrix OS

Execute work through the existing Matrix CLI with narrow directories, structured results, and reattachable sessions.

## Minimal readiness gate

Before every direct task, verify the local CLI, hosted profile, login, identity, and instance:

```bash
matrix --version
matrix profile show cloud
matrix doctor
matrix whoami
matrix status
matrix instance info
```

If login is missing or expired, run `matrix login --profile cloud` and let the user complete browser/device authentication. If the instance is not provisioned, use `https://app.matrix-os.com` and wait until it is ready.

Check only the selected agent inside the VPS:

```bash
matrix run --json -- codex --version
matrix run --json -- codex login status
matrix run --json -- claude --version
matrix run --json -- claude auth status
```

Run only the Codex pair or the Claude pair, not both. Authenticate a disconnected agent in a unique interactive session such as `auth-codex-<suffix>` or `auth-claude-<suffix>`. Never scan, read, or upload local credential files during onboarding. If the agent is missing, ask before installing a global tool and prefer Matrix's visible developer-tool installation path.

## Validate the destination

- Convert the requested location to a safe relative destination under the Matrix home.
- Reject empty paths, absolute paths, backslashes, control characters, and `.` or `..` path segments.
- Use `apps/<slug>` for a runnable Matrix app and `projects/<name>` for ordinary development work. Validate each slug or name before using it.
- Inspect an existing destination before running anything there. Stop if its type or contents conflict with the request.

Use a bounded probe from the Matrix home before applying `-C`:

```bash
matrix run --json -- test -e <dir>
matrix run --json -- test -d <dir>
matrix run --json -- ls -la <dir>
```

For a new app, create the normalized directory first:

```bash
matrix run --json -- mkdir -p -- apps/<slug>
matrix run --json -C apps/<slug> -- pwd
```

`-C` selects an existing directory; it never creates it. Do not pass a nonexistent path to `matrix run -C`.

## Run bounded one-shot commands

Use argv after `--` so each value remains a command argument:

```bash
matrix run --json -C <dir> -- <argv...>
```

Do not interpolate user input or prompts into `sh -c`, `bash -lc`, command substitutions, or a single shell string. Parse the JSON envelope and inspect `data.exitCode`, `data.timedOut`, and `data.truncated` as well as stdout and stderr. A timeout maps to exit status 124. Report non-zero status, timeout, and truncation; never infer success from partial output.

Use one-shot execution only for work expected to finish within the current Matrix run timeout. Use a named session for longer work.

## Run coding-agent tasks

Use Codex read-only mode for inspection:

```bash
matrix run --json -C <dir> -- codex --ask-for-approval never --sandbox read-only exec -- <prompt>
```

Use workspace-write only for the narrow validated target directory:

```bash
matrix run --json -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
```

Pair unattended Codex execution with `--ask-for-approval never` and an explicit sandbox. Prohibited actions must fail instead of waiting for approval. Never use `danger-full-access` without explicit user direction. Pass the prompt as one command argument after `--`, never as interpolated shell text.

For work likely to exceed the one-shot timeout, create a unique session such as `task-<slug>-<suffix>`:

```bash
matrix run -it --session <session-name> -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
matrix shell connect <session-name>
```

Keep Claude supervised unless a separately verified sandboxed noninteractive invocation is available. Start it in a unique named interactive session scoped with `-C`, let the user supervise its native flow, and do not invent unattended bypass flags.

## Handoff

Report the normalized destination, exact argv, structured exit outcome, validation performed, changed files when applicable, session name, and `matrix shell connect <session-name>` command.

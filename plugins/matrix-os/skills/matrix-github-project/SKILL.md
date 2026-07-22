---
name: matrix-github-project
description: Clone, verify, reuse, and change GitHub repositories in observable sessions on a Matrix OS cloud computer. Use when a user supplies a GitHub repository, asks to continue work in an existing checkout, wants a Matrix app checkout, or requests code changes and validation on Matrix.
---

# Work on GitHub Projects in Matrix OS

Authenticate and inspect everything on the Matrix VPS, preserve existing work, and push or open a PR only when explicitly requested.

## Session policy

- Always run remote work with `matrix run -it --session <session-name> ... -- <argv...>`.
- Never create or use shell tabs. Create a separate uniquely named session for every additional command, terminal, or concurrent task.
- Use collision-resistant names such as `readiness-github-<suffix>`, `inspect-<repo>-<suffix>`, `clone-<repo>-<suffix>`, and `task-<slug>-<suffix>`.
- Report every session name and its `matrix shell connect <session-name>` command.
- Pass arguments after `--`; never interpolate user input into a shell string.

## Minimal readiness gate

Verify the local CLI, hosted profile, login, identity, and instance before touching a checkout:

```bash
matrix --version
matrix profile show cloud
matrix doctor
matrix whoami
matrix status
matrix instance info --json
```

If `matrix instance info` reports `ready: true` with `source: execution_probe`, continue and report that the management plane is degraded. Stop only when both management and execution checks fail.

If needed, run `matrix login --profile cloud` and let the user complete browser/device authentication. Wait for provisioning at `https://app.matrix-os.com` when no ready computer exists.

Check only the selected coding agent on Matrix, using a separate session for each check:

```bash
matrix run -it --session readiness-codex-<suffix> -- codex --version
matrix run -it --session readiness-codex-auth-<suffix> -- codex login status
matrix run -it --session readiness-claude-<suffix> -- claude --version
matrix run -it --session readiness-claude-auth-<suffix> -- claude auth status
```

Run only the Codex pair or Claude pair. Authenticate a disconnected agent in `auth-codex-<suffix>` or `auth-claude-<suffix>`. Never scan, read, or upload local credential files. If an agent is missing, ask before installing a global tool and prefer Matrix's visible developer-tool installation path.

GitHub authentication must also live on Matrix:

```bash
matrix run -it --session readiness-github-<suffix> -- gh --version
matrix run -it --session readiness-github-auth-<suffix> -- gh auth status
matrix run -it --session auth-github-<suffix> -- gh auth login --hostname github.com --git-protocol ssh --web
matrix shell connect auth-github-<suffix>
```

Use the login session only when needed, then re-run remote `gh auth status` in a new session. If `gh` is missing, ask before installing it globally and prefer Matrix's visible developer-tool installation path. Do not rely on the local computer's GitHub login.

## Resolve the repository and destination

1. Parse the requested GitHub URL or `owner/repo` identifier and normalize it to a lowercase GitHub owner/repository pair with any `.git` suffix removed.
2. Default ordinary repositories to `projects/<repo>`. Use `apps/<slug>` only when the checkout should run directly as a Matrix app.
3. Validate a safe relative destination under the Matrix home. Reject absolute paths, backslashes, control characters, and `.` or `..` segments.
4. Inspect the destination before using `-C`.

Probe the destination in separate sessions:

```bash
matrix run -it --session inspect-exists-<repo>-<suffix> -- test -e projects/<repo>
matrix run -it --session inspect-type-<repo>-<suffix> -- test -d projects/<repo>
matrix run -it --session inspect-list-<repo>-<suffix> -- ls -la projects/<repo>
```

If the destination is absent, clone it with remote GitHub CLI:

```bash
matrix run -it --session clone-<repo>-<suffix> -- gh repo clone <owner>/<repo> projects/<repo>
matrix shell connect clone-<repo>-<suffix>
```

If the destination exists:

- Stop on a non-Git directory collision.
- Read `git remote get-url origin` and derive its normalized GitHub owner/repository.
- Reuse the checkout only when that normalized owner/repository exactly matches the request.
- Stop on a mismatched origin; never repoint it automatically.

## Preserve the checkout

Before fetching, switching, installing, launching an agent, or editing, inspect the branch and dirty state in separate sessions:

```bash
matrix run -it --session inspect-status-<repo>-<suffix> -C <dir> -- git status --porcelain=v1 --branch
matrix run -it --session inspect-branch-<repo>-<suffix> -C <dir> -- git branch --show-current
matrix run -it --session inspect-origin-<repo>-<suffix> -C <dir> -- git remote get-url origin
```

Treat staged, unstaged, untracked, rebasing, merging, and detached states as meaningful user work. Never reset, clean, stash, or overwrite user changes automatically. If the checkout is dirty or mid-operation, stop and ask whether to continue on the current state, finish the operation, or choose a separate clean checkout.

For a clean new task, follow repository instructions and the user's branch preference. If no branch is specified, resolve the remote default branch with `gh repo view`, fetch it, and create `matrix/<task-slug>` from the remote default branch. Stop if the target branch already exists rather than overwriting it.

## Understand and change the project

Read repository instructions before choosing commands:

- `AGENTS.md`, `CLAUDE.md`, or equivalent repository instructions, including nested files for the target area.
- README files and contributing guidance.
- Package-manager lockfiles and task scripts.
- Environment examples such as `.env.example`; never read secret environment files unless the user explicitly authorizes a specific read.
- Build, test, and development documentation.

Use a separate session for the coding task. For unattended Codex changes:

```bash
matrix run -it --session task-codex-<suffix> -C <dir> -- codex --ask-for-approval never --sandbox workspace-write exec -- <prompt>
matrix shell connect task-codex-<suffix>
```

Use `--sandbox read-only` for inspection. Never use `danger-full-access` without explicit direction.

Run Claude without repetitive permission questions using its verified auto mode:

```bash
matrix run -it --session task-claude-<suffix> -C <dir> -- claude --permission-mode auto -p <prompt>
matrix shell connect task-claude-<suffix>
```

If Claude auto mode is unavailable, report that limitation and stop; do not fall back to a permission bypass.

Run relevant validation in new purpose-specific sessions. Do not install dependencies until the package manager, lockfile, and dirty state are understood. Push or open a PR only when explicitly requested.

## Handoff

Report the normalized repository, checkout path, branch, starting dirty state, changed files, validation commands and results, every running session, and every `matrix shell connect <session-name>` reattach instruction. State clearly whether anything was pushed or published.

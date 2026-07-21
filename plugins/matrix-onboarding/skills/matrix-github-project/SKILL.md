---
name: matrix-github-project
description: Clone, verify, reuse, and change GitHub repositories on a Matrix OS cloud computer. Use when a user supplies a GitHub repository, asks to continue work in an existing checkout, wants a Matrix app checkout, or requests code changes and validation on Matrix.
---

# Work on GitHub Projects in Matrix OS

Authenticate and inspect everything on the Matrix VPS, preserve existing work, and push or open a PR only when requested.

## Minimal readiness gate

Verify the local CLI, hosted profile, login, identity, and instance before touching a checkout:

```bash
matrix --version
matrix profile show cloud
matrix doctor
matrix whoami
matrix status
matrix instance info
```

If needed, run `matrix login --profile cloud` and let the user complete browser/device authentication. Wait for provisioning at `https://app.matrix-os.com` when no ready computer exists.

Check only the selected coding agent on Matrix:

```bash
matrix run --json -- codex --version
matrix run --json -- codex login status
matrix run --json -- claude --version
matrix run --json -- claude auth status
```

Authenticate a disconnected agent in a unique interactive session such as `auth-codex-<suffix>` or `auth-claude-<suffix>`. Never scan, read, or upload local credential files during onboarding. If an agent is missing, ask before installing a global tool and prefer Matrix's visible developer-tool installation path.

GitHub authentication must also live on Matrix:

```bash
matrix run --json -- gh --version
matrix run --json -- gh auth status
matrix run -it --session auth-github-<suffix> -- gh auth login --hostname github.com --git-protocol ssh --web
```

Use the unique login session only when needed, then re-run remote `gh auth status`. If `gh` is missing, ask before installing it globally and prefer Matrix's visible developer-tool installation path. Do not rely on the local computer's GitHub login.

## Resolve the repository and destination

1. Parse the requested GitHub URL or `owner/repo` identifier and normalize it to a lowercase GitHub owner/repository pair with any `.git` suffix removed.
2. Default ordinary repositories to `projects/<repo>`. Use `apps/<slug>` only when the checkout should run directly as a Matrix app.
3. Apply the safe relative destination rules: reject absolute paths, backslashes, control characters, and `.` or `..` segments.
4. Probe the destination from the Matrix home before using `-C`.

If the destination is absent, clone with remote GitHub CLI:

```bash
matrix run --json -- gh repo clone <owner>/<repo> projects/<repo>
```

For a clone likely to exceed the one-shot timeout, use a unique `clone-<repo>-<suffix>` interactive session and report its reattach command.

If the destination exists:

- Stop on a non-Git directory collision.
- Read `git remote get-url origin` and derive its normalized GitHub owner/repository.
- Reuse the checkout only when that normalized owner/repository exactly matches the request.
- Stop on a mismatched origin; never repoint it automatically.

## Preserve the checkout

Before fetching, switching, installing, launching an agent, or editing, inspect:

```bash
matrix run --json -C <dir> -- git status --porcelain=v1 --branch
matrix run --json -C <dir> -- git branch --show-current
matrix run --json -C <dir> -- git remote get-url origin
```

Treat staged, unstaged, untracked, rebasing, merging, and detached states as meaningful user work. Never reset, clean, stash, or overwrite user changes automatically. If the checkout is dirty or mid-operation, stop and ask whether to continue on the current state, finish the operation, or choose a separate clean checkout.

For a clean new task, follow repository instructions and the user's branch preference. If no branch is specified, resolve the remote default branch with `gh repo view`, fetch it, and create `matrix/<task-slug>` from the remote default branch. Stop if the target branch already exists rather than overwriting it.

## Understand and change the project

Read repository instructions before choosing commands:

- `AGENTS.md`, `CLAUDE.md`, or equivalent repository instructions, including nested files for the target area.
- README files and contributing guidance.
- Package-manager lockfiles and task scripts.
- Environment examples such as `.env.example`, never secret environment files unless the user explicitly authorizes a specific read.
- Build, test, and development documentation.

Apply the requested change with the selected agent's safe workflow. For unattended Codex, pass the prompt as an argument and use `--ask-for-approval never --sandbox workspace-write` scoped by `matrix run -C <dir>`. Use `--sandbox read-only` for inspection. Never use `danger-full-access` without explicit direction. Keep Claude supervised unless its sandboxed noninteractive invocation has been separately verified.

Run the relevant validation from repository instructions. Do not install dependencies until the package manager, lockfile, and dirty state are understood. Push or open a PR only when explicitly requested.

## Handoff

Report the normalized repository, checkout path, branch, starting dirty state, changed files, validation commands and results, any running session, and `matrix shell connect <session-name>` reattach instructions. State clearly whether anything was pushed or published.

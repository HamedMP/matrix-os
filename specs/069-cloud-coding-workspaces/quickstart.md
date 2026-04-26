# Quickstart: Cloud Coding Workspaces

This quickstart describes the target user flow once the 069 feature is implemented. It is also the manual acceptance path for phased delivery.

## Prerequisites

- Matrix container is running for the user.
- Matrix CLI is logged in.
- GitHub CLI is installed in the container.
- User has authenticated GitHub with `gh auth login`.
- Agent CLIs are installed and authenticated as needed: Claude, Codex, OpenCode, and/or Pi.
- Zellij is available; tmux/direct PTY fallback is configured.
- Browser IDE route is available at `code.matrix-os.com`.

## Add A Project

```bash
matrixos project add github.com/FinnaAI/matrix-os
matrixos project ls
matrixos project prs matrix-os
matrixos project branches matrix-os
```

Expected:

- Project appears in the Matrix workspace project list.
- `~/projects/matrix-os/config.json` exists.
- Repository is cloned under the managed project path.
- PR and branch listings use the same state in CLI, TUI, and web.

## Open A PR Worktree

```bash
matrixos worktree create matrix-os --pr 42
matrixos worktree ls matrix-os
```

Expected:

- Matrix creates or reuses a stable `wt_...` worktree.
- The worktree records source branch, current branch, PR number, dirty state, and path.
- Dirty cleanup requires explicit confirmation.

## Start And Attach To An Agent Session

```bash
matrixos session start --project matrix-os --pr 42 --agent claude
matrixos session ls
matrixos session attach <sessionId>
matrixos session attach <sessionId> --terminal
```

Expected:

- Session record appears under `~/system/sessions/`.
- Zellij session is created when available.
- Browser terminal, CLI stream, TUI, and native Zellij attach all point to the same coding session.
- Gateway restart preserves transcript replay and session discovery.

## Create A Task And Work On It

```bash
matrixos task create "Fix auth middleware validation" --project matrix-os
matrixos task ls --project matrix-os
matrixos task work <taskId> --agent codex
```

Expected:

- Task appears in board/list views.
- Agent session links to the task and selected working area.
- Task status reflects session state such as running, waiting, failed, exited, or complete.

## Use The Browser IDE

Open:

```text
https://code.matrix-os.com/?folder=/home/matrixos/home/projects/matrix-os/repo
```

Expected:

- Editor opens through Matrix auth without exposing code-server directly.
- Static assets, workers, fonts, icons, and WebSocket requests load with correct MIME/auth/cache behavior.
- File edits are visible immediately from Matrix shells and git status.

## Run A Review Loop

```bash
matrixos review start --project matrix-os --pr 42
matrixos review status --project matrix-os --pr 42
matrixos review watch --project matrix-os --pr 42
```

Expected:

- Review loop creates or reuses the PR worktree and acquires its write lease.
- Reviewer writes `.matrix/review-round-1.md` and `.matrix/review-round-1.json`.
- Parser records findings and severity counts.
- Implementer fixes findings and records a commit SHA.
- Loop repeats until converged, stalled, failed, failed_parse, stopped, or approved.

## Open The TUI

```bash
matrixos
# or
matrixos tui
```

Expected:

- Dashboard shows sessions, reviews, projects, PRs, worktrees, and tasks.
- `j/k`, arrows, Enter, and section shortcuts navigate the dashboard.
- Attach/watch/native-terminal handoff use the same session IDs as the web workspace.

## Recovery Checks

Restart the gateway or container, then run:

```bash
matrixos project ls
matrixos session ls
matrixos review status --project matrix-os --pr 42
```

Expected:

- State ops replay before workspace is marked healthy.
- Runtime sessions are reconciled with file records.
- Worktree leases are retained or recovered according to runtime liveness.
- Transcript replay is available for existing sessions.
- Browser IDE health is reported.

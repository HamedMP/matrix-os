---
description: Create an isolated worktree PR, monitor CI and review comments, iterate until Greptile is 5/5, then report completion.
---

# Worktree PR Monitor

Usage: `/worktree-pr-monitor <short branch slug or task summary>`

Arguments:

```text
$ARGUMENTS
```

## Goal

Move the requested change through the full Matrix OS PR loop:

1. create or use an isolated git worktree,
2. implement and validate the change,
3. open or update a GitHub PR,
4. monitor CI plus review comments,
5. keep fixing until Greptile reports `5/5`,
6. ping the requester with the PR URL, final Greptile status, and validation summary.

## Rules

- Keep `/home/deploy/matrix-os` on `main`. Put feature work under `/home/deploy/matrix-os.worktrees/<slug>`.
- Use a semantic branch and PR title. Do not prefix the PR title with agent/tool tags.
- Never stage unrelated changes. Inspect `git status --short --branch` before staging.
- Do not merge unless explicitly asked.
- If Greptile has reviewed the PR, GitHub mergeability alone is not enough. The loop is done only when the latest trusted Greptile result is `5/5`.
- Treat human review, Codex review comments, and unresolved GitHub review threads as blockers until acknowledged or fixed.
- If feedback conflicts with the task, reply with the rationale and ask before changing behavior.

## Workflow

1. Resolve scope and slug.
   - Derive a concise slug from `$ARGUMENTS` or the current task.
   - Worktree path: `/home/deploy/matrix-os.worktrees/<slug>`.
   - Branch: `codex/<slug>` unless the task names a specific branch.

2. Create the worktree from current `origin/main`.
   - From `/home/deploy/matrix-os`, verify `git status --short --branch`.
   - If there are relevant uncommitted changes in main, stash or patch only those files, create the worktree, then apply them inside the worktree.
   - Run `git worktree add -b <branch> /home/deploy/matrix-os.worktrees/<slug> origin/main`.

3. Implement in the worktree.
   - Follow TDD where practical: reproduce or add a failing regression first, then fix.
   - Keep diffs scoped to the task.
   - Re-check `git status --short --branch` before staging.

4. Validate.
   - Run the narrow tests for the changed area.
   - Run repo-required checks when feasible:
     - `bun run typecheck`
     - `bun run check:patterns`
     - `bun run test`
   - If a broad check is not run, state the reason in the PR body and final ping.

5. Commit and push.
   - Commit with a Conventional Commit message.
   - Push with `git push -u origin HEAD`.

6. Open or update the PR.
   - Use a semantic PR title such as `fix(canvas): keep terminal controls clickable`.
   - PR body must include:
     - `Summary`
     - `Tests`
     - `Review/Monitoring`
     - `Invariants` for backend changes

7. Monitor until done.
   - Watch checks with `gh pr checks --watch` or GitHub Actions status APIs.
   - Inspect unresolved review threads with the GitHub review-thread workflow, not only flat comments.
   - Watch Greptile comments/status. Continue only when the latest trusted Greptile result is `5/5`.
   - If Greptile reports findings, implement fixes in the same worktree, rerun relevant checks, commit, push, and keep monitoring.

8. Ping completion.
   - Report:
     - PR URL
     - branch and worktree path
     - latest commit SHA
     - checks run and result
     - latest Greptile status, explicitly `5/5`
     - any residual risk or skipped check
   - If blocked, ping with the exact blocker and next action needed.

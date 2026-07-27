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

Move an explicitly requested manual git worktree change through the full Matrix
OS PR loop:

1. create or use an isolated git worktree,
2. implement and validate the change,
3. open or update a GitHub PR,
4. monitor CI plus review comments,
5. keep fixing until Greptile reports `5/5`,
6. ping the requester with the PR URL, final Greptile status, and validation summary.

## Rules

- Use this command only when the requester explicitly asks for a worktree PR
  workflow. Otherwise, follow the repo's current-branch agent workflow.
- This command does not authorize Swarm `isolation: "worktree"`; that repo-level
  Swarm ban still applies.
- Keep `/home/deploy/matrix-os` on `main`. Put feature work under `/home/deploy/matrix-os.worktrees/<slug>`.
- Use a semantic branch and PR title. Do not prefix the PR title with agent/tool tags.
- Never stage unrelated changes. Inspect `git status --short --branch` before staging.
- Do not merge unless explicitly asked.
- Greptile only reviews when a comment mentions `@greptileai`, and each run costs money. Request it once per head SHA, and only after every local gate passes. An absent Greptile review means nobody asked, not that a review is pending.
- Review the diff locally with your own coding agent before requesting Greptile. Greptile is the paid final gate, not the first reviewer.
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

7. Request the Greptile review, then monitor until done.
   - **Greptile does not review automatically.** It runs only when a comment mentions `@greptileai`, and every run costs money. A PR with no such comment will sit indefinitely with no review — that is not a review in progress.
   - **Request it only when the branch is final and every local gate has already passed**: `bun run typecheck`, `bun run check:patterns`, `bun run test`, plus `npx react-doctor@latest <project-dir>` for each changed React project. Never request a review to find out whether the change works.
   - **Run a local review pass first, with the coding agent you are already using.** Greptile is the paid final gate, not the first reviewer. Review the real diff (`git diff origin/main...HEAD`) using `/code-review` in Claude Code, the equivalent review command in Codex, or the three review passes from `docs/dev/review-pipeline.md` (mechanical `check:patterns` sweep, trust-boundary sweep, atomicity/failure-mode review) plus the AGENTS.md Hard Rules. Fix what it finds and re-run the gates before requesting Greptile.
   - Post exactly one request per review round: `gh pr comment <number> --body "@greptileai review"`
   - A push that changes the head SHA makes the previous review stale. Post one new `@greptileai` request for the new head; do not post repeat mentions while a review for the current head is still running.
   - Watch checks with `gh pr checks --watch` or GitHub Actions status APIs.
   - Inspect unresolved review threads with the GitHub review-thread workflow, not only flat comments.
   - Watch Greptile comments/status. Continue only when the latest trusted Greptile result is `5/5`.
   - If Greptile reports findings, implement fixes in the same worktree, rerun relevant checks, commit, push, request one new review for the new head, and keep monitoring.

8. Ping completion.
   - Report:
     - PR URL
     - branch and worktree path
     - latest commit SHA
     - checks run and result
     - latest Greptile status, explicitly `5/5`
     - any residual risk or skipped check
   - If blocked, ping with the exact blocker and next action needed.

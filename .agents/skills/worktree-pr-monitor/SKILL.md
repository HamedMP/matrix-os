---
name: worktree-pr-monitor
description: Create or continue an isolated Matrix OS worktree PR, validate it, push it, monitor CI and GitHub review feedback, iterate until the latest trusted Greptile result is 5/5, then add ready-for-ci and wait for triggered CI to pass before pinging completion. Use when asked to run a worktree to PR to monitor workflow, get a PR to Greptile 5/5 plus CI pass, publish changes while keeping main clean, or monitor one worktree, branch, and PR exclusively assigned to a leaf agent.
---

# Worktree PR Monitor

Use this skill only when the requester explicitly asks for the manual git
worktree -> PR -> monitor workflow or a coordinator assigns that workflow to a
leaf agent. It keeps `/home/deploy/matrix-os` on `main` while implementation
happens in `/home/deploy/matrix-os.worktrees/<slug>`.

Do not use this skill to coordinate Swarm or multi-agent runs. A leaf agent may
use it only when a coordinator gives it exclusive ownership of one worktree,
branch, and PR. The repo-level Swarm ban on `isolation: "worktree"` still
applies; this workflow uses a persistent manual git worktree.

## Preconditions

- `gh` is installed and authenticated.
- The current repository is `HamedMP/matrix-os`.
- The repository has a label exactly named `ready-for-ci`; if it is missing,
  stop and report the blocker instead of creating the label silently.
- The requester or coordinating workflow wants a PR in a worktree, not only a
  local patch.
- The requester explicitly asked for a worktree or a coordinator explicitly
  assigned this leaf workflow.

## Rules

- If neither the requester nor a coordinator explicitly assigned a worktree,
  follow the current branch workflow instead.
- Keep `/home/deploy/matrix-os` on `main`.
- Put feature work in `/home/deploy/matrix-os.worktrees/<slug>`. A leaf agent
  must use its coordinator-assigned worktree path instead.
- Use a semantic branch and PR title. Do not prefix titles with agent/tool tags.
- Stage only files in scope.
- Do not merge unless explicitly asked.
- If Greptile has reviewed the PR, the loop is complete only when the latest
  trusted Greptile result is `5/5`.
- Add the `ready-for-ci` label only after the latest trusted Greptile result is
  `5/5`; this label triggers the broader PR CI workflows.
- If the repository label `ready-for-ci` is missing, report the blocker instead
  of creating the label or treating the PR as CI-ready.
- If label-triggered CI fails, remove `ready-for-ci`, fix the failures, commit
  and push, then return to the Greptile fulfillment loop before re-adding the
  label.
- Treat unresolved human review threads, Codex review issue comments, and
  Greptile findings as blockers until they are fixed, acknowledged, or
  explicitly deferred by the requester.

## Workflow

1. Establish scope.
   - Inspect `git status --short --branch`.
   - If main contains relevant uncommitted work, move only that work into the
     target worktree via a scoped stash or patch.
   - If unrelated changes are present, leave them alone and ask only if they
     block the requested PR.

2. Create or enter the worktree.
   - Slug: concise task slug, e.g. `fix-canvas-terminal-clicks`.
   - Branch: `codex/<slug>` unless the requester named a branch.
   - Path: `/home/deploy/matrix-os.worktrees/<slug>`, or the exact path assigned
     by the coordinator for a leaf agent.
   - Command shape:
     `git worktree add -b codex/<slug> /home/deploy/matrix-os.worktrees/<slug> origin/main`

3. Implement.
   - Follow TDD where practical: add a failing focused regression before the
     fix, then make it green.
   - Keep edits scoped and compatible with Matrix OS conventions.

4. Validate.
   - Run the narrow changed-area tests.
   - Run broader Matrix gates when feasible:
     - `bun run typecheck`
     - `bun run check:patterns`
     - `bun run test`
   - Record any skipped broad check with the exact reason.

5. Commit and push.
   - Commit with a Conventional Commit message.
   - Push with `git push -u origin HEAD`.

6. Open or update the PR.
   - Use `gh pr view` to detect an existing PR for the branch.
   - Create or edit the PR with a semantic title.
   - PR body must include:
     - `Summary`
     - `Tests`
     - `Review/Monitoring`
     - `Invariants` when backend code changed

7. Monitor review feedback until Greptile is complete.
   - Use `gh pr checks --watch` or equivalent GitHub API status reads for
     already-running checks.
   - Use thread-aware review inspection for unresolved GitHub review threads.
   - Inspect issue comments for Codex reviews.
   - Inspect Greptile feedback and rating. If the latest trusted Greptile
     result is below `5/5`, implement fixes, rerun relevant checks, commit,
     push, and continue monitoring.

8. Trigger and monitor label-gated CI.
   - Before labeling, verify that the repository label exists:
     `gh label list --search ready-for-ci --json name`. If the exact
     `ready-for-ci` label is missing, stop and report the blocker.
   - Once the latest trusted Greptile result is `5/5`, add the `ready-for-ci`
     label with `gh pr edit --add-label ready-for-ci`.
   - Wait for the triggered checks with `gh pr checks --watch` or equivalent
     GitHub API status reads.
   - If every required triggered check passes, the PR is ready.
   - If any triggered check fails, remove the `ready-for-ci` label with
     `gh pr edit --remove-label ready-for-ci`, inspect the failure, implement
     the fix, rerun relevant local checks, commit, push, and return to step 7.
     Do not re-add `ready-for-ci` until Greptile is again `5/5` on the latest
     commit.

9. Ping completion.
   - Reply with:
     - PR URL
     - branch and worktree path
     - latest commit SHA
     - checks run and result
     - latest Greptile status, explicitly `5/5`
     - `ready-for-ci` status and triggered CI result
     - skipped checks or residual risk
   - If blocked, reply with the exact blocker and the next action needed.

## Useful Commands

```sh
git status --short --branch
git worktree list
git worktree add -b codex/<slug> /home/deploy/matrix-os.worktrees/<slug> origin/main
bun run typecheck
bun run check:patterns
bun run test
git push -u origin HEAD
gh pr view --json number,url,title,state,headRefName,baseRefName
gh label list --search ready-for-ci --json name
gh pr edit --add-label ready-for-ci
gh pr edit --remove-label ready-for-ci
gh pr checks --watch
```

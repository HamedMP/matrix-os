---
name: worktree-pr-monitor
description: Create or continue one isolated Matrix OS manual-worktree PR, validate it, mark a completed draft ready, resolve current-head review feedback through Greptile 5/5, then add ready-for-ci and wait for triggered CI. Use when asked for the worktree-to-PR monitoring workflow, including when a coordinator assigns a leaf agent exclusive ownership of one worktree, branch, and PR.
---

# Worktree PR Monitor

Use this skill only when the requester explicitly asks for the manual Git
worktree -> PR -> monitor workflow or when a coordinator explicitly assigns
that workflow to a leaf agent. Keep the primary checkout unchanged while
implementation happens in a persistent manual worktree at the path required by
the repository instructions.

Do not use this skill to coordinate a Swarm or share a worktree between agents.
A leaf agent in a multi-agent run may use it only when it exclusively owns one
coordinator-assigned worktree, branch, and PR. The repo-level ban on Agent-tool
`isolation: "worktree"` still applies; use a persistent manual Git worktree.

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
- Keep the primary checkout on its existing branch and preserve unrelated work.
- Resolve the primary checkout's absolute path and, unless repository
  instructions specify another location, use the canonical sibling path
  `<primary-checkout-parent>/<repo-name>.worktrees/<slug>`. For example, a
  primary checkout at `/home/deploy/matrix-os` uses
  `/home/deploy/matrix-os.worktrees/<slug>`. Never reuse another agent's path.
- Use a semantic branch and PR title. Do not prefix titles with agent/tool tags.
- Stage only files in scope.
- Do not merge unless explicitly asked.
- If Greptile has reviewed the PR, the loop is complete only when the latest
  trusted Greptile result is `5/5` for the current PR head.
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
   - Path: the coordinator-assigned path for a leaf agent. Otherwise use the
     canonical absolute sibling path above unless repository instructions
     explicitly require another location.
   - Command shape:
     `git worktree add -b codex/<slug> /absolute/path/to/matrix-os.worktrees/<slug> origin/main`

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

7. Mark completed drafts ready for review.
   - Keep an incomplete PR in draft state.
   - After implementation and applicable local validation finish, inspect the
     PR state and run `gh pr ready` if it is still a draft.
   - Marking the PR ready may trigger baseline CI. Monitor those checks, but do
     not treat them as a substitute for the later `ready-for-ci` gate.

8. Monitor review feedback until Greptile is complete.
   - Use `gh pr checks --watch` or equivalent GitHub API status reads for
     already-running checks.
   - Use thread-aware review inspection for unresolved GitHub review threads.
   - Inspect issue comments for Codex reviews.
   - Inspect Greptile feedback and rating for the current PR head. If the latest
     trusted result is stale or below `5/5`, implement fixes, rerun relevant
     checks, commit, push, and continue monitoring.

9. Trigger and monitor label-gated CI.
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

10. Ping completion.
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
git worktree add -b codex/<slug> /absolute/path/to/matrix-os.worktrees/<slug> origin/main
bun run typecheck
bun run check:patterns
bun run test
git push -u origin HEAD
gh pr view --json number,url,title,state,headRefName,baseRefName
gh pr ready
gh label list --search ready-for-ci --json name
gh pr edit --add-label ready-for-ci
gh pr edit --remove-label ready-for-ci
gh pr checks --watch
```

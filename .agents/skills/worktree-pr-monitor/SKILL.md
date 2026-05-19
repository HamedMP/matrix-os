---
name: worktree-pr-monitor
description: Create or continue an isolated Matrix OS worktree PR, validate it, push it, monitor CI and GitHub review feedback, iterate until the latest trusted Greptile result is 5/5, then ping the requester with completion status. Use when asked to run a worktree -> PR -> monitor workflow, get a PR to Greptile 5/5, or publish changes while keeping main clean.
---

# Worktree PR Monitor

Use this skill for Codex-driven publish loops that must keep `/home/deploy/matrix-os`
on `main` while implementation happens in `/home/deploy/matrix-os.worktrees/<slug>`.

## Preconditions

- `gh` is installed and authenticated.
- The current repository is `HamedMP/matrix-os`.
- The requester wants a PR, not only a local patch.

## Rules

- Keep `/home/deploy/matrix-os` on `main`.
- Put feature work in `/home/deploy/matrix-os.worktrees/<slug>`.
- Use a semantic branch and PR title. Do not prefix titles with agent/tool tags.
- Stage only files in scope.
- Do not merge unless explicitly asked.
- If Greptile has reviewed the PR, the loop is complete only when the latest
  trusted Greptile result is `5/5`.
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
   - Path: `/home/deploy/matrix-os.worktrees/<slug>`.
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

7. Monitor.
   - Use `gh pr checks --watch` or equivalent GitHub API status reads.
   - Use thread-aware review inspection for unresolved GitHub review threads.
   - Inspect issue comments for Codex reviews.
   - Inspect Greptile feedback and rating. If the latest trusted Greptile
     result is below `5/5`, implement fixes, rerun relevant checks, commit,
     push, and continue monitoring.

8. Ping completion.
   - Reply with:
     - PR URL
     - branch and worktree path
     - latest commit SHA
     - checks run and result
     - latest Greptile status, explicitly `5/5`
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
gh pr checks --watch
```

---
name: worktree-pr-monitor
description: Take one Matrix OS change from a manual git worktree to a merge-ready PR - verify the Linear ticket, implement and validate, open a draft PR, get Greptile to 5/5 on the current head, mark it ready, and watch CI until it passes. Use when asked to ship a change as a PR, run the worktree to PR to monitor workflow, or get a PR to Greptile 5/5 plus green CI.
---

# Worktree PR Monitor

Use this skill to carry a standalone change through the Matrix OS PR loop, or
when invoked as `worktree-pr-monitor`. The request may give a branch slug or a
task summary. For dependent PRs use a GitHub native stack and
`monitor-stack-reviews` instead.

`AGENTS.md` is the source of truth for every rule this skill applies. Where
this file and `AGENTS.md` disagree, follow `AGENTS.md` and say so.

## Preconditions

- `gh` is installed and authenticated (`gh auth status`).
- You are in a checkout of the Matrix OS repository.
- A Linear ticket covers the task. Follow the Linear Ticket Check in
  `AGENTS.md`: reuse an existing ticket, and ask once before creating one.

## Rules

- All changes ship from a manual git worktree. Never commit to `main`, and
  never use the Agent tool's `isolation: "worktree"`.
- Use a kebab-case branch and a Conventional Commit PR title with no agent or
  tool tag.
- Stage explicit paths only. Check `git status --short --branch` first and
  leave unrelated changes alone.
- Do not merge unless asked. A merge request authorizes only that merge; every
  gate below still applies.
- Approval is risk-tiered (`docs/dev/review-pipeline.md#risk-tiered-merge-approval`):
  a `5/5` with Greptile's own approval (Low/Medium risk) can merge; a `5/5`
  without it (High/Critical) needs a human approval. Report which applies;
  never self-approve or use admin bypass.
- Greptile reviews only when asked. After every push, post
  `@greptileai please review` once, unless a review already names the new head
  or `node scripts/review/review-carryover.mjs check <pr>` accepts the earlier
  one.
- Read the score and `Last reviewed commit` from the comment that contains
  `greptile_summary`, and compare that SHA with the PR's `headRefOid`. A score
  for an older head is not a score for this one. Follow the stale-review table
  in `AGENTS.md`.
- Unresolved human review threads, Codex review comments, and Greptile findings
  are blockers until fixed, answered, or explicitly deferred by the requester.
- If feedback conflicts with the task, reply with the reason and ask before
  changing behavior.
- A failed check is a finding, not noise. Read the log before calling it
  unrelated, and say what you found.

## Workflow

1. **Establish scope.**
   - Inspect `git status --short --branch` in the main checkout.
   - If it holds uncommitted work for this task, move only that work into the
     worktree with a scoped stash or patch.

2. **Create or enter the worktree.**
   - `git fetch origin main`, then
     `git worktree add -b <kebab-branch> ../<dir-name> origin/main`.
   - Run `pnpm install --frozen-lockfile` in the new worktree before testing.

3. **Implement.**
   - Tests first: add a failing focused test, then make it pass
     (`docs/dev/testing-effectiveness.md`).
   - Keep the diff to the task and under the PR size limits.

4. **Validate.**
   - Run the focused tests for the changed area
     (`pnpm exec vitest run <path>`).
   - Run the Pre-PR Checklist in `AGENTS.md`: `bun run typecheck`,
     `bun run check:patterns`, `bun run test`, and
     `npx react-doctor@latest <project-dir>` when a React file changed. Run
     `bun run build:shell:production` when `shell/` or the auth shell changed.
   - Record any check you skipped and why.

5. **Commit and push.**
   - Commit with a Conventional Commit message that names the ticket.
   - `git push -u origin HEAD`.

6. **Open or update the PR.**
   - `gh pr view` to find an existing PR for the branch; otherwise
     `gh pr create --draft`.
   - Use the PR body template in `AGENTS.md`: `Summary`, `Tests`, `Process`
     with the Linear link, and collapsed `Invariants` for backend changes.
   - A user-visible change needs the surface matrix and live evidence gate from
     `AGENTS.md`. Missing evidence is a readiness blocker; report it.

7. **Get Greptile to 5/5 on the current head.**
   - Request the review (see Rules) and wait; a review usually lands within a
     few minutes.
   - Read findings from the summary comment and from the inline review
     comments. Fix valid ones test-first, push, and request again.
   - Repeat until the current head, or a head the carry-over check accepts, is
     `5/5`.

8. **Mark ready and watch CI.**
   - `gh pr ready` starts full PR CI. Watch it with `gh pr checks --watch`.
   - On a failure, read the failing job's log. Fix a real failure: convert the
     PR back to draft (`gh pr ready --undo`), push the fix, and return to
     step 7. For a failure the diff cannot have caused, say what it is and
     rerun the failed jobs.

9. **Report.**
   - PR URL, branch, worktree path, and head SHA.
   - Checks run and their result, including anything skipped.
   - Greptile score and the commit it reviewed.
   - Approval state: Greptile-approved, or waiting on a human.
   - If blocked: the exact blocker and the next action.

10. **After the merge.** Stop here. Do not remove the worktree, delete
    branches, or close tickets as part of this skill. Tell the requester that
    the `wrap-up` skill does that cleanup, and run it only when they ask.

## Useful Commands

```sh
git status --short --branch
git worktree list
git worktree add -b <kebab-branch> ../<dir-name> origin/main
pnpm exec vitest run <path>
bun run typecheck && bun run check:patterns
gh pr create --draft
gh pr comment <n> --body "@greptileai please review"
node scripts/review/review-carryover.mjs check <n>
gh pr ready
gh pr checks <n> --watch
gh run view --job <job-id> --log-failed
```

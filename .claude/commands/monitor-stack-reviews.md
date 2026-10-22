---
description: Monitor a GitHub native PR stack through Greptile 5/5, marking PRs ready for review, and CI.
argument-hint: [pr-or-range-or-branch]
---

# Monitor Stack Reviews

Usage: `/monitor-stack-reviews <pr-or-range-or-branch>`

Arguments:

```text
$ARGUMENTS
```

## Goal

Monitor every PR in an existing GitHub native stack, inspect Greptile feedback, fix
actionable review findings, mark each PR ready for review (which starts full CI)
only after Greptile is `5/5`, and keep monitoring CI until every non-deferred stack PR is ready for
final human review.

## Rules

- Use the official `github/gh-stack` extension for stack operations. If unavailable,
  stop and report the blocker instead of falling back to raw branch surgery.
- Use `gh` for GitHub PR metadata, checks, draft/ready state, and review
  comments. Run `gh auth status` before network operations. If `gh` is missing
  or unauthenticated, stop and report the blocker instead of treating GitHub
  command failures as PR state.
- Never merge PRs unless the requester explicitly asks.
- Do not create worktrees, create implementation branches, or open new feature
  PRs. This command is for monitoring and fixing an existing PR/stack. Use `/worktree-pr-monitor` for the implementation stage.
- Full PR CI runs on every non-draft head. Do not mark a PR ready for review
  (`gh pr ready <number>`) before the latest trusted Greptile review for that
  PR is `5/5`. There is no command-level override for this gate.
- In this command, a *current-head* `5/5` also includes a `5/5` on an earlier
  head that `node scripts/review/review-carryover.mjs check <pr>` accepts (exit 0;
  exit 1 needs a fresh review, exit 3 means the check could not decide: fix
  `gh`/git access and rerun). Restacks, retargets, and
  base merges keep the PR's own diff, so they keep the review; do not request a
  re-review for them. New PR work or conflict resolutions fail the check and
  need a fresh review.
- Never force-push over remote work outside the requested native stack branches
  unless the requester explicitly approves that exact risk. Cascading rebases
  necessarily rewrite stack branch SHAs; they are permitted only after verifying
  the branch is part of the requested stack and the remote head still matches
  the head observed before editing/submitting.
- Keep fixes in the relevant stack layer. If a finding belongs to a lower PR,
  check out that branch, patch there, commit explicit paths with Git, then
  rebase descendants with `gh stack rebase --no-trunk`.
- Treat unresolved human review threads, Codex review comments, and Greptile
  findings as blockers until fixed, acknowledged, or explicitly deferred.
- Automatic creation reviews may be disabled; pushes do not guarantee a review.
  After publication, request once per new head with `@greptileai please review`.
  Match the reviewed commit to the current head, or confirm carry-over with
  `node scripts/review/review-carryover.mjs check <pr>`, and follow `AGENTS.md`'s bounded
  retry rules; do not repeatedly ping while the same-head review is in flight.
- Do not stage unrelated files. Run `git status --short --branch` before every
  staging operation.
- Before a cascading rebase, verify every affected worktree is clean and idle;
  preserve another task's branch, active process and unfinished work. Do not
  force an occupied checkout or bypass a paused operation's lock.

## Workflow

1. Resolve the stack.
   - If `$ARGUMENTS` contains a PR number/range, inspect those PRs with `gh pr view`.
   - If `$ARGUMENTS` contains a branch, use `gh stack view --json` from its owning
     worktree and `gh pr list --head`. Use the native stack REST API for remote
     membership when no local tracking exists; do not mutate just to read status.
   - If no arguments are provided, use the current branch and `gh stack view --json`.
   - Verify native membership and bottom-to-top order. PR arguments must resolve
     to the intended stack, not merely happen to have consecutive numbers.
   - Produce an ordered list of PR number, branch, base, draft state, and URL.

2. Validate reviewability.
   - If any PR is still draft, report that Greptile may not run for that PR until
     a human or a separate explicit action marks it ready. Do not convert it from
     this command. Continue monitoring and fixing the remaining non-draft PRs in
     stack order; keep each draft PR listed as a blocker in the final status.
   - Always keep the PR order intact, regardless of draft state. Do not alter
     bases manually or flatten dependencies; report malformed native membership.

3. Monitor Greptile and reviews first.
   - Inspect PR review threads with a thread-aware GitHub workflow, not only
     flat issue comments.
   - Inspect Greptile comments/status. Record the latest trusted Greptile
     rating per PR, especially whether it is `5/5`.
   - Audit ready-for-review state before any fixes. For each monitored PR,
     compare it with the latest Greptile review and current `headRefOid`; also
     inspect unresolved human review threads, unresolved Codex review comments,
     and unresolved actionable issue comments. Convert a ready PR back to draft
     immediately if it is not backed by a current-head `5/5` review, or if any
     unresolved review blocker is present:
     `gh pr ready <number> --undo`.
   - Do not treat CI as the primary gate until Greptile has reached `5/5` for
     the PR. If CI is already running, record status but keep Greptile first.
   - Before each edit/submit iteration, snapshot the current remote head for
     every PR that could be rewritten by the next native stack rebase/submit:
     `gh pr view <number> --json headRefOid,headRefName`. Keep this baseline
     with the branch list for the Step 4 conflict check.

4. Fix actionable feedback.
   - Cluster findings by branch and behavior.
   - Before editing any file, verify the checked-out branch matches the PR branch
     that owns the fix: run `git branch --show-current` and compare it to the
     target PR's `headRefName`. If it differs, run
     `gh stack checkout <target-branch>` and re-check the branch before editing.
     If occupied elsewhere, use its owning worktree once idle instead of forcing
     the checkout or editing the wrong layer.
   - For code behavior changes, add or adjust a focused failing regression
     before the implementation change. Do not edit behavior code until the
     regression exists. For docs-only fixes, keep the edit scoped to the
     reviewed workflow.
   - Before any edit that will lead to a new push for a PR that is ready for
     review, convert that PR and every descendant PR whose head will be
     rewritten by the next stack rebase/submit back to draft:
     `gh pr ready <number> --undo`. Mark them ready again only after each
     rewritten PR has a current-head `5/5` again, either carried
     over by the check or from a fresh Greptile review.
   - Run the narrow relevant tests after the fix. Before staging or committing,
     also run `git diff --check`, `bun run typecheck`,
     `bun run check:patterns`, and `bun run test`. If an external outage or
     existing repo-wide blocker makes a mandatory gate impossible to complete,
     stop and report the exact blocker instead of committing or submitting.
   - If any React `.tsx` or `.jsx` file changed, run this gate before staging or
     committing:
     `npx react-doctor@latest <project-dir>` for each affected React project
     directory that has a `package.json` (for example, `shell` or `packages/ui`).
     Do not pass individual files to react-doctor. For default apps
     under `home/apps/**`, create a temporary React project outside the repo with
     `mktemp -d` (for example under `/tmp`), copy the affected app `src/` files
     plus a minimal React `package.json`, run react-doctor against that temporary
     directory, and delete the temporary directory in cleanup even when
     react-doctor fails.
     Resolve findings before committing, or report the exact reason the gate
     could not run.
   - Inspect `git status --short --branch` and stage only files belonging to the
     owning branch's fix with explicit paths:
     `git add <paths>`, then `git commit -m "<conventional commit>"` or an intentional
     `git commit --amend`. Do not stage unrelated work with `--all`.
   - Rebase descendants without fetching or pushing before the pre-submit safety
     check: `gh stack rebase --no-trunk`.
     Run this after any commit that touches a layer below the
     stack tip before submitting, so descendants are anchored to the rewritten
     parent SHA. If it reports merge conflicts or leaves the worktree
     in a conflicted state, stop immediately and report the conflicted branch,
     files, and current stack state; do not attempt autonomous conflict
     resolution inside this monitor command.
   - Before submitting, verify the
     current remote head for every branch that will be rewritten still matches
     the head recorded for this edit iteration; if it changed unexpectedly,
     stop and report the remote-work conflict.
   - Submit only after the remote-head safety check passes:
     `gh stack submit --auto`. Before invoking it, confirm every locally tracked
     layer has an existing open PR in the requested native stack and there are
     no extra local layers. Otherwise stop: submit can create PRs, while this
     monitor must not create them.
   - After every successful submit, discard the pre-submit
     baseline and immediately refresh the remote-head snapshot for every
     monitored PR before entering another fix loop. A cascading rebase can
     rewrite stack branch SHAs; the published SHAs become the
     next iteration's conflict baseline.
   - After every successful rebase or submit, re-run the Step 3 readiness
     audit for the edited PR and all descendants, converting back to draft any
     PR that is no longer backed by a current-head `5/5` Greptile review.
   - If a finding is ambiguous or conflicts with the product intent, draft a
     concise response and ask before changing behavior.

5. Continue until complete.
   - Re-poll checks and Greptile after each pushed fix, waiting at least
     60 seconds between polls. Do not stop only because an already-running CI
     job remains `queued`, `pending`, or `in_progress` across consecutive
     polls; normal Matrix OS checks can run longer than several poll intervals.
     Track a CI-start wait timer from the push time for each PR expected to run
     checks. Stop and report a blocker only when checks fail with actionable
     output, expected checks have not entered `queued`, `pending`, or
     `in_progress` within 30 minutes after the push, or an active check exceeds
     30 minutes without progress or its workflow-defined `timeout-minutes`,
     whichever is shorter. Report the never-active case as
     `CI checks never became active for <pr> @ <sha>`.
   - Track a review-wait start time and current head SHA for each PR awaiting
     Greptile. Initialize the timer at command start for any PR whose current
     head lacks a trusted Greptile review before this command makes changes, and
     reset it to the push time after every successful submit that rewrites that
     PR. If no Greptile comment for that head appears within 30 minutes after
     that PR's review-wait start time, stop and report
     `Greptile review not received for <pr> @ <sha>` as a blocker instead of
     polling indefinitely.
   - Trust a Greptile score only when its reviewed commit matches the PR's
     current `headRefOid`, or when `node scripts/review/review-carryover.mjs check <pr>`
     exits 0 for it; otherwise treat it as stale and request a fresh review.
   - When the latest trusted Greptile result is `5/5` and there are no
     unresolved human review threads, unresolved Codex review comments, or
     unresolved actionable issue comments, mark the PR ready for review if it
     is still a draft: `gh pr ready <number>`. If any review thread or
     actionable comment remains unresolved, keep it a draft.
   - After marking it ready, monitor CI with `gh pr checks <number>` or run-level APIs
     until checks pass, fail with actionable output, or are blocked. During
     this CI loop, periodically re-audit review threads and actionable comments
     with the same thread-aware workflow from Step 3. If any new unresolved
     human thread, Codex review comment, or actionable issue comment appears,
     stop treating the PR as complete and return to the Step 3 readiness audit
     before declaring success.
   - If any fix requires a new push after the PR was marked ready, convert it
     back to draft before editing: `gh pr ready <number> --undo`. Mark it ready
     again only after
     the new commit has a current-head `5/5`, either carried over by the check
     or from a fresh Greptile review.
   - Completion requires every monitored PR to be either:
     - latest trusted Greptile `5/5` with no unresolved human review threads,
       unresolved Codex review comments, or unresolved actionable issue
       comments, or
     - explicitly deferred with the reason and follow-up.
   - For non-deferred PRs with Greptile `5/5`, completion also requires the
     PR to be ready for review and CI to be passing or explicitly
     blocked by an external condition.

6. Report status.
   - Include the PR list, branch list, latest commit, checks run, current
     Greptile rating for each PR, draft/ready state, CI state, fixes
     made, and residual risks.
   - If blocked, state the exact blocker and next required action.

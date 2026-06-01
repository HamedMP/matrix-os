---
description: Monitor a Graphite PR stack through Greptile 5/5, ready-for-ci labeling, and CI.
argument-hint: [pr-or-range-or-branch]
---

# Monitor Stack Reviews

Usage: `/monitor-stack-reviews <pr-or-range-or-branch>`

Arguments:

```text
$ARGUMENTS
```

## Goal

Monitor every PR in an existing Graphite stack, inspect Greptile feedback, fix
actionable review findings, add the `ready-for-ci` label only after Greptile is
`5/5`, and keep monitoring CI until every non-deferred stack PR is ready for
final human review.

## Rules

- Use Graphite for stack operations. If `gt` is missing or unauthenticated,
  stop and report the blocker instead of falling back to raw branch surgery.
- Use `gh` for GitHub PR metadata, checks, draft/ready state, and review
  comments. Confirm `gh auth status` before network operations if auth is
  uncertain.
- Never merge PRs unless the requester explicitly asks.
- Do not create worktrees, create implementation branches, open new feature PRs,
  or convert draft PRs to ready. This command is for monitoring and fixing an
  existing PR/stack. Use `/worktree-pr-monitor` for the implementation stage.
- Do not add `ready-for-ci` before the latest trusted Greptile review for that
  PR is `5/5`, unless the requester explicitly overrides this gate.
- If the `ready-for-ci` label is missing from the repository, stop and report
  the blocker instead of creating a label silently.
- Never force-push over remote work outside Graphite-managed stack branches
  unless the requester explicitly approves that exact risk. Graphite restacks
  necessarily rewrite stack branch SHAs; they are permitted only after verifying
  the branch is part of the requested stack and the remote head still matches
  the head observed before editing/submitting.
- Keep fixes in the relevant stack layer. If a finding belongs to a lower PR,
  check out that branch, patch there, amend or commit with Graphite, then
  restack descendants.
- Treat unresolved human review threads, Codex review comments, and Greptile
  findings as blockers until fixed, acknowledged, or explicitly deferred.
- Do not repeatedly ping Greptile. Wait for new reviews triggered by pushed
  commits and poll status/comments instead.
- Do not stage unrelated files. Run `git status --short --branch` before every
  staging operation.

## Workflow

1. Resolve the stack.
   - If `$ARGUMENTS` contains a PR number/range, inspect those PRs with `gh pr view`.
   - If `$ARGUMENTS` contains a branch, use `gt log short` and `gh pr list --head`.
   - If no arguments are provided, use the current branch and `gt log short`.
   - Produce an ordered list of PR number, branch, base, draft state, and URL.

2. Validate reviewability.
   - If any PR is still draft, report that Greptile may not run until a human or
     a separate explicit action marks it ready. Do not convert it from this
     command.
   - Always keep the PR order intact, regardless of draft state. Do not alter
     bases manually unless Graphite reports the stack is malformed.

3. Monitor Greptile and reviews first.
   - Inspect PR review threads with a thread-aware GitHub workflow, not only
     flat issue comments.
   - Inspect Greptile comments/status. Record the latest trusted Greptile
     rating per PR, especially whether it is `5/5`.
   - Audit existing `ready-for-ci` labels before any fixes. For each monitored
     PR, compare the label state with the latest Greptile review and current
     `headRefOid`; remove `ready-for-ci` immediately if the label is not backed
     by a current-head `5/5` review:
     `gh pr edit <number> --remove-label "ready-for-ci"`.
   - Do not treat CI as the primary gate until Greptile has reached `5/5` for
     the PR. If CI is already running, record status but keep Greptile first.
   - Before each edit/submit iteration, snapshot the current remote head for
     every PR that could be rewritten by the next Graphite submit:
     `gh pr view <number> --json headRefOid,headRefName`. Keep this baseline
     with the branch list for the Step 4 conflict check.

4. Fix actionable feedback.
   - Cluster findings by branch and behavior.
   - For each actionable finding, edit the owning branch, add/adjust focused
     tests where practical, and rerun the narrow relevant tests.
   - Use Graphite to modify/restack and submit updates:
     `gt modify --all` or `gt modify --commit --all --message "<conventional commit>"`,
     `gt restack` when needed, and `gt submit --stack --no-edit --no-ai`.
   - Before staging, inspect `git status --short --branch` and stage only files
     belonging to the owning branch's fix. Before submitting, verify the
     current remote head for every branch that will be rewritten still matches
     the head recorded for this edit iteration; if it changed unexpectedly,
     stop and report the remote-work conflict.
   - After every successful `gt submit --stack`, discard the pre-submit
     baseline and immediately refresh the remote-head snapshot for every
     monitored PR before entering another fix loop. Graphite's successful
     submit intentionally rewrites stack branch SHAs; those new SHAs become the
     next iteration's conflict baseline.
   - Run `git diff --check` and the narrow relevant tests before submitting.
     For backend, shell, or shared behavior, also run the relevant typecheck or
     pattern scanner when practical and report any skipped broad gate.
   - If a finding is ambiguous or conflicts with the product intent, draft a
     concise response and ask before changing behavior.

5. Continue until complete.
   - Re-poll checks and Greptile after each pushed fix, waiting at least
     60 seconds between polls. If three consecutive polls show no review/check
     state change, stop and report the current blocker instead of looping.
   - Trust a Greptile score only when its reviewed commit matches the PR's
     current `headRefOid`; otherwise treat it as stale and keep waiting.
   - When the latest trusted Greptile result for a PR is `5/5`, add the
     repository label exactly named `ready-for-ci` if it is not already present:
     `gh pr edit <number> --add-label "ready-for-ci"`.
   - After labeling, monitor CI with `gh pr checks <number>` or run-level APIs
     until checks pass, fail with actionable output, or are blocked.
   - If actionable CI failure fixes require a new push after `ready-for-ci` was
     applied, remove the label before editing:
     `gh pr edit <number> --remove-label "ready-for-ci"`. Re-add it only after
     a fresh current-head Greptile review returns `5/5` for the new commit.
   - Completion requires every monitored PR to be either:
     - latest trusted Greptile `5/5`, or
     - explicitly deferred with the reason and follow-up.
   - For non-deferred PRs with Greptile `5/5`, completion also requires the
     `ready-for-ci` label to be present and CI to be passing or explicitly
     blocked by an external condition.

6. Report status.
   - Include the PR list, branch list, latest commit, checks run, current
     Greptile rating for each PR, `ready-for-ci` label state, CI state, fixes
     made, and residual risks.
   - If blocked, state the exact blocker and next required action.

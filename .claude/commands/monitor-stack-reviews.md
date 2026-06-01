---
description: Monitor a Graphite PR stack, make drafts ready, fix review feedback, and loop until Greptile is 5/5.
argument-hint: [pr-or-range-or-branch]
---

# Monitor Stack Reviews

Usage: `/monitor-stack-reviews <pr-or-range-or-branch>`

Arguments:

```text
$ARGUMENTS
```

## Goal

Monitor every PR in a Graphite stack, make draft PRs ready for review when
requested, inspect CI plus Greptile feedback, fix actionable review findings,
and keep iterating until every non-deferred stack PR has the latest trusted
Greptile result at `5/5`.

## Rules

- Use Graphite for stack operations. If `gt` is missing or unauthenticated,
  stop and report the blocker instead of falling back to raw branch surgery.
- Use `gh` for GitHub PR metadata, checks, draft/ready state, and review
  comments. Confirm `gh auth status` before network operations if auth is
  uncertain.
- Never merge PRs unless the requester explicitly asks.
- Never force-push over remote work unless the requester explicitly approves
  that exact risk.
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

2. Make the stack reviewable when requested.
   - If the requester asked for Greptile to run, convert draft PRs to ready:
     `gh pr ready <number>`.
   - Keep the PR order intact. Do not alter bases manually unless Graphite
     reports the stack is malformed.

3. Monitor CI and reviews.
   - Use `gh pr checks <number>` or run-level APIs for check status.
   - Inspect PR review threads with a thread-aware GitHub workflow, not only
     flat issue comments.
   - Inspect Greptile comments/status. Record the latest trusted Greptile
     rating per PR, especially whether it is `5/5`.

4. Fix actionable feedback.
   - Cluster findings by branch and behavior.
   - For each actionable finding, edit the owning branch, add/adjust focused
     tests where practical, and rerun the narrow relevant tests.
   - Use Graphite to modify/restack and submit updates:
     `gt modify --all`, `gt restack`, and `gt submit --stack --no-edit --no-ai`.
   - If a finding is ambiguous or conflicts with the product intent, draft a
     concise response and ask before changing behavior.

5. Continue until complete.
   - Re-poll checks and Greptile after each pushed fix.
   - Completion requires every monitored PR to be either:
     - latest trusted Greptile `5/5`, or
     - explicitly deferred with the reason and follow-up.

6. Report status.
   - Include the PR list, branch list, latest commit, checks run, current
     Greptile rating for each PR, fixes made, and residual risks.
   - If blocked, state the exact blocker and next required action.

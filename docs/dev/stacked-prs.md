# GitHub Native Stacked PR Workflow

Matrix OS always uses GitHub native stacks for dependent PRs, managed with the
official `github/gh-stack` extension. A small independent change stays one ordinary
GitHub PR. Keep dependencies explicit and each layer independently reviewable.

A stack may share one ENG ticket assigned to the requester. Every layer links
that ticket and the native GitHub stack. Separate tickets per layer are optional.
Link specs for substantial changes and suggest stakeholder review. UI changes
still require live evidence for every affected surface under `AGENTS.md`.

## When To Stack

Split features or refactors along review boundaries: spec/docs, shared contracts,
gateway, platform, UI, and rollout. Aim for fewer than 1000 additions and 20 files
per PR; never exceed 3000 additions or 50 files without splitting. Follow
[Large File Refactoring](large-file-refactoring.md) for extraction boundaries.
Preserve Spec Kit phase boundaries in the tasks document's **GitHub Stack Plan**.

## Setup

Install the official extension and verify GitHub authentication:

```bash
gh auth status
gh extension install github/gh-stack   # once, if missing
gh stack --version
```

If authentication, the extension, or native stack support is unavailable, report
the setup blocker. Do not switch stack tools or flatten dependencies.

Create a named manual worktree from the fetched remote trunk before editing:

```bash
git fetch origin main
git worktree add -b codex/messages-contracts /tmp/matrix-messages origin/main
cd /tmp/matrix-messages
gh stack init --base main codex/messages-contracts
gh stack view --json
```

`init` adopts the existing branch. Use Git for commits and `gh stack` for stack
membership. Inspect the affected worktrees before mutations; preserve the main
checkout, unfinished work, and any branch owned by another active task. The CLI
does not create your worktree or move an occupied branch into this checkout.

## Create And Publish Layers

Commit one complete slice before adding its dependent branch:

```bash
git add <contract-paths>
git commit -m "feat(messages): add setup contracts"
gh stack add codex/messages-permissions
# Implement and validate the next slice, then:
git add <permission-paths>
git commit -m "feat(messages): add permission gates"
gh stack submit --auto
```

`submit` publishes all layers and creates or updates their PRs and native stack.
With `--auto`, new PRs start as drafts; use `--auto --open` only when authorized
and ready for review. Set Conventional Commit titles and concise bodies with
`gh pr edit <number> --title "<title>" --body-file <file>`. Every body links the
shared ENG ticket, native stack, applicable spec and validation evidence. Keep
mandatory invariants in the body. Open the PR with `gh pr view <number> --web`.

For existing published PRs, first verify their ordered heads, bases and ownership,
then adopt them without rewriting code:

```bash
gh stack link <bottom-pr> <next-pr> <top-pr>
```

Arguments are bottom-to-top. `link` creates or updates native membership without
local stack tracking; use `gh stack checkout <stack-number>` when local tracking
is needed. Inspect the result rather than assuming a command succeeded.

## Address Review Feedback

1. Record the remote head SHA for each affected PR, including descendants.
2. Audit readiness labels. Remove `ready-for-ci` before editing a layer or
   rebasing descendants that currently carry the label.
3. Check out the owning layer with `gh stack checkout <branch>` and verify
   `git branch --show-current` against its PR's `headRefName`. If another
   worktree owns it, use that worktree once idle; do not steal its branch.
4. Fix feedback, run the relevant validation, and commit explicit paths with
   Git. Use `git commit --amend` only for an intentional history rewrite.
5. Rebase descendants onto their updated parents with `gh stack rebase --no-trunk`.
   This keeps the existing trunk position. To incorporate newer trunk work,
   inspect affected worktrees and use `gh stack rebase` or `gh stack sync` only
   when safe; sync also pushes and can invalidate reviews.
6. For conflicts, stage the deliberate resolution and use
   `gh stack rebase --continue`, or `gh stack rebase --abort` to restore the
   pre-rebase stack. The review monitor reports conflicts instead of guessing.
7. Recheck remote SHAs against the saved baseline before publication. If another
   task changed one, stop and reconcile its work. Never use an unconditional
   force push. Publish with `gh stack submit`; refresh the remote head baseline.
8. Request Greptile once for each new head with `@greptileai please review`.
   Match the summary's **Last reviewed commit** to `headRefOid`; an old 5/5 is
   stale. Follow the bounded retry rules in `AGENTS.md` rather than repeated pings.
9. Restore `ready-for-ci` proactively only after current-head 5/5 and zero
   unresolved review blockers. Verify all applicable CI jobs pass for that head.

`gh stack modify` restructures membership; it is not a commit-amend command.
Do not sync or rebase a frozen, reviewed stack just to refresh its status.
Read status with `gh stack view --json`, PR metadata, reviews and CI APIs.
Use `/monitor-stack-reviews <pr-or-range-or-branch>` for the full monitoring loop.

## Merge Through GitHub

Merge only with requester authorization and all included PR gates satisfied:

- Native stack base is `main`; membership is the intended bottom-to-top order.
- Every included head is unchanged from its reviewed and CI-tested SHA.
- Each PR is ready, has current-head Greptile 5/5, zero unresolved blockers,
  `ready-for-ci`, and passing applicable CI, with task/spec/evidence linked.

```bash
gh stack merge <stack-number> --yes --squash
```

GitHub's native merge lands the included layers into the stack base atomically.
Child PRs correctly target their preceding layer; do not retarget every child to
`main` or loop `gh pr merge`. To land an approved prefix, pass its top PR number
instead of the stack number and check every included dependency's gates first.
Do not pass a custom squash subject or bypass repository rules.

If GitHub queues the stack, continue monitoring. A request accepted by the CLI
is not proof of a merge. Verify each included PR's `state`, `mergedAt`,
`headRefOid`, and `mergeCommit` using `gh pr view`; record the actual commits.
On failure, inspect GitHub's error and fix the blocker, preserving the stack.

Close completed tickets only after verified merge. Remove a completed local
worktree only when it is clean, contains no commits after the reviewed head,
and no active task/process needs it. Keep the main checkout and uncertain or
unfinished worktrees. Do not delete branches while later PRs remain open.

## References

- [Official gh-stack commands and worktree behavior](https://github.com/github/gh-stack)
- [GitHub native stack REST API](https://docs.github.com/en/rest/pulls/stacks)
- [Review Pipeline](review-pipeline.md) and `AGENTS.md`

# Read qualification without mistaking orchestration for testing

Use the current repository's `docs/dev/fast-ci.md` for routing and operator
procedures and `docs/dev/stacked-prs.md` for native stacks. Those maintained
procedures take precedence over historical examples. Run commands from the
verified repository/worktree on the selected Matrix computer.

## Read-only starting points

```bash
gh auth status
node scripts/review/pr-readiness.mjs <pr>
gh pr view <pr> --json headRefOid,headRefName,baseRefName,isDraft,reviewDecision,mergeable,statusCheckRollup
gh pr checks <pr>
gh run view <run-id> --json headSha,event,attempt,status,conclusion,jobs,url
gh run view <run-id> --log-failed
```

Inspect review threads with the GitHub thread-aware API, including pagination.
Match Greptile's **Last reviewed commit** to the live head; an edited comment's
timestamp does not identify its reviewed commit. For an earlier 5/5, use the
repository's `scripts/review/review-carryover.mjs check` helper. Missing access
is unknown state, not an empty inventory or approval.

The shared report paginates review threads/reviews, delegates Greptile validity
to the carry-over verifier, checks current-head independent approval and lists
required status links. It fails closed on collection errors or source movement.
It deliberately leaves qualification unverified: green status rollups, including
draft no-ops, cannot establish artifact provenance. Review issue comments,
finding dispositions and the manual gates remain necessary. Never use its exit
0 alone as merge permission or publish it as a trusted required policy check.

When a shipped skill changes, check installation and both actual discovery
paths: the kernel loader and Chat catalog/recipe resolution. Keep the all-shipped
trigger/link and installer-parity checks. A successful file copy or kernel load
does not establish Chat availability. The affected contract cohort includes
`tests/kernel/*skill*.test.ts`, `tests/platform/matrix-agent-skills-sync.test.ts`
and `tests/gateway/chat-agent-recipe.test.ts`; exercise the added skill's actual
resolved body, source and hash too. Run these through the existing isolated job.

## Evidence distinctions

| Observed result | What it establishes |
| --- | --- |
| Draft-event CI is successful but workloads/aggregate skipped | No full qualification; find the real ready-event attempt. |
| Routing job succeeded on Main or an isolated ref | Dispatch/routing only; follow its actual requester and workload. |
| Green full hosted CI | The authenticated exact source/attempt passed its required hosted jobs. |
| Green Linux diagnostic | Require the matching verified immutable receipt and complete phases/guards; a label, title or green controller alone is insufficient. |
| Neutral or superseded controller | No qualification credit. |
| Green source freshness check | Inspect its actual coverage proof; it is separate from required CI. |
| Green PR CI followed by a Main advance | Coverage remains for the actual tested source/parents under repository policy, not the newer Main tree. |
| Green Main CI plus another red diagnostic | Investigate the red check; do not call the whole commit green. |

Check run IDs and attempts, exact head/source SHA and ordered parents, workflow
identity and execution ref. Use current repository verification helpers where
available. Do not replace their receipt/authentication checks with name matching.
For artifacts, verify complete shard/file inventories and existing skip
identities before reporting whole-suite counts. A focused pass after a failed
full run is an affected-file rerun, not a new all-green full attempt.

On an authorized recovery, use the original source/request binding and genuine
retry mechanism. Keep queue, setup, test execution and end-to-end completion
times separate. A delayed controller may stand down because hosted recovery
already finished; its success does not imply that Linux ran.

## Preview and platform evidence

Read the owned preview comment and workflow artifacts. Record which commit was
built, which version is actually running, download platforms, expiry and queue
state. Distinguish CI artifacts requiring GitHub access from public downloads.
Do not pair a new web preview with an older installer without calling out the
mismatch. A build URL alone does not prove that the desktop can connect to the
requested preview; exercise that connection when desktop evidence is required.

Use the current private-preview commands only when that is the chosen mode:

```bash
matrix preview list --json
```

`preview-bundle` builds/registers PR provenance without provisioning. Creating
or updating a private preview is a separate requested operation. Consult the
current command help and preview handbook for confirmations and actual limits;
the unified 16-slot queue, private previews and platform previews are different
capabilities. Never assume a planned label, capacity or platform is deployed.

# Preserve required CI through delayed metadata events

## Problem and outcome

The collaboration preview-pair stack had genuine passing full CI, yet three
PRs could not merge. A newer metadata suite captured draft state, renamed or
skipped its aggregate, and hid the older `CI Results`. The merge box showed
`Expected` even though the workflow suite itself was successful. The agent's
historical-rollup audit missed that newest-suite distinction. Moving main
alone did not cause this incident.

Keep one stable `CI Results` job for every suite. Draft/metadata events execute
only the existing coverage verifier, which must authenticate live readiness
and genuine prior coverage before succeeding. An actual draft or unqualified
revision remains blocked. Never accept skips, metadata-on-metadata reuse,
routing-only coverage or arbitrary tree equivalence as passing tests.

## Authority, integration and failure behavior

`ci.yml` dispatches the existing `metadata-result.mjs` verifier for captured
draft or non-base metadata events. Real source events retain full qualification.
The verifier binds the live PR head, repositories and base ref before and after
reading coverage. Non-main parents retain exact base/merge identity; main
advancement retains the existing protected recorded-source provenance policy.
The shared aggregate authenticator checks the actual Actions job/check, attempt,
issuer, source, details URL and suite identity when supplied by the run.

The GET-only `check-pr-readiness.mjs` command inspects the newest current-head
PR suite, including metadata; it never searches only for successful coverage.
It returns blocked for a missing or unsuccessful aggregate and errors for API
failure or incomplete bounded history. Existing monitors call it before
reporting CI green. Other required workflows, reviews and native mergeability
still need their existing checks. No repository policy, status write, dispatch,
rerun, deletion, merge, customer runtime or access change is introduced.

API operations retain 10-second request timeouts; the CLI subprocess has a
15-second timeout and 4 MiB output cap per request. History is limited to ten
100-row pages per scan (initial selection and final recheck) and the job inventory
to 100 rows; overflow fails closed. There
are no persistent collections, writes, locks, transactions or temporary files
in production. Inspection is a snapshot; run it again immediately before merge.

## Acceptance and delivery

| Starting state / actor | Action and observable result | Fault or recovery protected | Boundary |
| --- | --- | --- | --- |
| Ready PR, passing genuine CI; delayed captured draft event | Stable required aggregate verifies prior real coverage without heavy jobs | New suite cannot omit the required context | Actual YAML conditions and real verifier |
| Live draft, changed head/repository/base, or absent/failed/pending coverage | Verifier rejects; no green replacement | Stale event cannot qualify another revision | Live PR and Actions API fixtures |
| Older full success; newer metadata suite lacks aggregate | Readiness command reports blocked and identifies newest run | Historical green rollup cannot imply merge readiness | Real monitor helper with incident-shaped API data |
| Newest metadata suite has authenticated successful aggregate | Readiness reports that suite, job and attempt as passing | No unnecessary workload rerun | Shared Actions authenticator |

No Matrix OS renderer or customer runtime is affected: Web Canvas, Web Desktop,
Electron Desktop, Web Mobile and Native Mobile have no changed rendering or
runtime behavior. Review is recommended from the CI/platform owner. This work
does not claim live testing of a late-event GitHub race from mocked API tests.
Capture the new PR's actual Actions results and read-only readiness output.

Deliver the code/tests and monitor documentation in a standalone unmerged PR,
plus a separate canonical developer-documentation PR in
`FinnaAI/matrix-os-site/content/docs/`. Keep Slack posting disabled per requester.
Retain strict stack merge identity: native generated-merge equivalence and
automatic repair of old, already-created workflow definitions are separate
changes and cannot bypass source qualification here.

## Local qualification

The captured-draft workflow regressions were red (3 cases), live-source/final
identity regressions were red (8 cases), and the newer-suite-during-inspection
regression was red before its final recheck. The completed focused suite passes
162/162 cases. The full relevant CI contract suite passes 1,816/1,816 Vitest
cases across 71 files, including its nested Python qualification contracts.
All eight configured typecheck projects pass; the pattern scan reports zero
violations and five existing warnings. All four changed/new JS modules pass
Node syntax checks. The companion developer-page MDX compiles.

Run with real subprocess access and `umask 022`, matching CI. This host's default
`002` first caused two unchanged fixture failures: queued-lock cancellation
and source-mode validation (775 versus expected 755). The committed baseline
reproduced the lock failure; both pass with 022, without modifying their tests
or runtime authorization. Sandbox-denied subprocess runs are not qualification.

Read-only live checks authenticated PR #3124's successful run 41856014088,
attempt 1, suite 113418984548, and rejected the actual draft PR #3132. These
reads do not qualify the new PR's hosted CI or prove a live delayed-event replay.
Greptile and new-PR hosted results remain pending publication and tracking.

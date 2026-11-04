# ENG-93 Main matching integration

Tracking: [ENG-93](https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent).

The subsequent integration with Main ece22, including the merged login-cache
fix and dependency upgrades, is recorded in [eng93-main-ece22.md](./eng93-main-ece22.md).
The Main933f/aea artifacts below retain their original historical identity.

The preserved candidate3c0ee9595ea/production16b1b04c is integrated with official Main933f2dab7dc8a8dc7e7e3f7ca4e58d6d2c7c1bad in a separate worktree. The requester explicitly approved the minimal two-history migration bridge and background task integration after reviewing the semantic conflicts. No existing candidate/history/evidence is overwritten. Old PG56 is not qualification of this new tree.

## Immutable migration histories

Main v9 `question_source_run` remains the canonical migration with unchanged SQL. Historical `bot_chat_threads` v9 retains its original name and applied_at; its frozen five SQL statements remain independently tested. The bootstrap accepts that one alternate identity only with the full new registry and verified nullable text/project column, both validated CHECK definitions and a ready valid nonunique three-key partial index. Other identities are refused before pending DDL.

New v10 `bot_question_threads_bridge` adds only the missing side under the existing schema advisory lock/transaction: thread-v9 gains the question source column/check; question-v9 gains the original dormant thread schema. New v11 `bot_routines` adds routines. No migration history rows, grants, authorization flags, pins, saved data, or source-run identities are rewritten. The old unpublished routine-v10 candidate is rejected rather than relabeled; its artifacts remain usable only with its own retained source. Unknown or incomplete histories fail closed. Migration tests cover both native-PG branches, immutable owner state, concurrent startup, forged/incomplete history and transactional rollback/retry.

## Canonical task startup and cancellation

Background runs claim only their specific queued/no-run or safe-capacity-blocked task using the existing revision CAS within `beginBotTask`'s transaction, then publish the normal task event. They never continue unrelated foreground waiting work. Main's exact saved-answer/responder/sourceRun checks remain in the interactive branch. Main's bounded setup/abort and late task settlement/runtime release remain in the orchestrator, including background source resolution. Background work still requires the exact ChatGPT-plan subscription/background source, cannot enter isolated funded/group routes, and is not offered routine-authoring or native task delegation tools. No grants or credential policies are expanded.

The local process qualification still doubles external source readiness, scope-host admission/renewal and model transport. Renewal is an explicit synthetic handle, not proof of real scope lease renewal. Actual Linux DynamicUser launch, native account/background consent, real model execution and per-surface visual evidence remain separate gates in `eng93-live-acceptance.md`. Full runtime/client builds and new-head native PG receipts must be recorded against the final source SHA; a component worker build or metadata snapshot cannot stand in for them.

No endpoints or auth matrix change. Existing authenticated owner list/control and interaction endpoints remain private/no-store with bounded input. Required local checks: old routine/owner/fencing suites, new two-history and background-task regressions, Main saved-answer/cancellation/stream continuation suites, scoped strict types, native PG/process qualification, matching artifact hashes and independent review. Later publication still requires a public-safe matrix-os-site documentation PR plus exact-build live evidence in the PR and tech channel; no publication, Slack, deployment or GUI action is authorized here.

## Production package boundary

Gateway routine schemas/types are consumed through the declared `@matrix-os/contracts` package export. Relative imports into contracts source force that file into the gateway emission root and break its canonical build. Keep gateway rootDir/strict unchanged; require a full frozen Linux build and packaged loader smoke, because broad-root scoped type checks alone do not enforce this release boundary.

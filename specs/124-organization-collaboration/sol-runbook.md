# Sol execution handoff — direct architecture

Read spec.md, plan.md, research.md, data-model.md, contracts/organization-api.md and quickstart.md. This is a handoff, not a dispatch. Previous S00–S24 assignments are superseded. Use gpt-5.6-sol, high reasoning; at most three independently scoped workers and one coordinator.

| Packet | Task IDs | Responsibility |
| --- | --- | --- |
| S00 | T001–T005 | Baseline and live boundary probes |
| S01 | T006–T009 | Extract large composition seams |
| S02 | T010–T014 | Freeze shared wire contracts |
| S03 | T015–T019 | Clerk roles and control authority |
| S04 | T020–T024 | Local granular authority |
| S05 | T025–T029, T103 | Transparent relay, home sessions, tickets and revocation |
| S06 | T030–T034 | Direct clients and resource discovery |
| S07 | T035–T039 | Execution sandbox and task policies |
| S08 | T040–T044 | Single owner source and run funding |
| S09 | T045–T049 | Shared Codex and Claude execution |
| S10 | T050–T054 | Chat worktrees and Git concurrency |
| S11 | T055–T059 | Local and peer integration delegation |
| S12 | T060–T064 | Direct resource adapters and sync |
| S13 | T065–T069 | Computer-to-computer migration and recovery |
| S14 | T070–T074 | Org billing and invitation compute choices |
| S15 | T075–T079 | Shared permission/readiness and org UI |
| S16 | T080–T083 | Managed Matrix group text |
| S17 | T084–T087 | Native Mobile and CLI parity |
| S18 | T088–T092 | One coordinated migration and removal |
| S19 | T093–T097 | Release acceptance and docs |
| S20 | T098–T102 | Org-only precondition and release-gate removal (executes immediately after S01, before S02) |

## Assignment prompt

> Implement packet Sxx, tasks Tnnn–Tmmm, from specs/124-organization-collaboration/tasks.md. Read the constitution and applicable directory instructions, then all feature artifacts. Verify prerequisite SHAs in a persistent manual worktree from reviewed branches. Own only this packet’s files; you are not alone in the codebase: preserve others’ edits and coordinate overlapping modules. Start with failing behavior tests, use real Postgres for races/migration/leases, and record exact red/green results. Reuse canonical Chat, provider V3, worktree and authority seams. V1 is a default shared project group Chat with one owner source and owner-controlled commits/PRs. Sharing exists only inside an organization; the organization is the only gate. The confirmed 525 collaboration interaction model is the UI baseline: add state and controls inside its chrome and never introduce new collaboration headers, composers, share dialogs or inboxes. Open UI decisions listed in spec.md are answered by the product owner, not by you. Transport is a transparent platform relay with all authorization on the home; clients resolve origins from the directory, tickets bind runtime ID and generation rather than a hostname, and the relay is extracted, not deleted. Defer participant accounts and copy-and-continue. Do not add a pooled org computer, collaboration payload proxy fallback, personal-subscription pooling, credential export, prompt-only sandbox, hidden wider file/integration access, a release flag, a rollout cohort, or a person-to-person sharing path. Supply coordinator registration/export changes. Return changed paths, tests, head/prerequisite SHAs, open gates and migration/recovery evidence. Do not merge, deploy, provision paid services or publish externally without authorization.

## Coordinator ownership

- Own shared package exports/manifests/lockfile, platform main/startup, gateway bootstrap, exact route/WS registration, signing configuration and release activation. Resolve dependencies at registration; no globalThis bridges.
- Integrate prerequisites explicitly; do not dispatch overlapping write sets. Keep small reviewed worktree PRs and follow docs/dev/stacked-prs.md. One release does not mean one giant diff.
- Recheck baseline if main changes. Preserve private/personal unrelated behavior while removing legacy collaboration serving paths at cutover. Do not invent test evidence, provider permission or prices.
- Completion receipts in implementation-log.md contain task IDs, base/head SHAs, changed files, observed RED, GREEN, DB/host/provider/surface evidence, unavailable modes, migration and rollback result. No credentials/private incident data.
- Required current-head Greptile 5/5 precedes ready-for-ci. Clean a worktree only after merged-head, clean-state and no-active-task checks. This task authorizes updating the existing specification PR only; implementation PRs, merge and deployment follow their own task scope.

## Gate handling

Missing credentials/sandboxes do not permit fake passes. Complete unaffected work and mark the specific probe unrun. Every enrolled customer VPS is eligible through the relay; do not add per-home hostnames or certificates. Missing org prices disable those paid choices. Unsupported subscription modes require a supported API/source selection, never a personal owner default. A failed required Codex/Claude API/worktree/sandbox mode blocks release acceptance. Native Matrix participation is deferred; the managed group service still needs its enforcement evidence. Failed cutover keeps collaboration fenced until recovery, without a legacy proxy fallback.

## Simplification receipt

S20 deletes the release flag, rollout cohort and person-to-person path before contracts freeze, so no later packet carries a personal-audience or cohort branch. S08 implements one project source rather than participant accounts. S09 enforces distinct discussion and AI submission. S10 owns default group Chat/root behavior and owner identity/approval for Git/PR operations. S15 presents one-click join with owner-configured execution readiness. Existing source IDs preserve future extension seams without dormant participant-account/clone code.

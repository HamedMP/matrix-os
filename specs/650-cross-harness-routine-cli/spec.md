# Unified cross-harness routine CLI

Status: approved for implementation by the owner's “可以就这样实现” on 2026-10-31. Approval covers the behavior below and isolated failure-first tests, not live accounts/permissions/background jobs, GUI, production, merge or deployment.

## Outcome

Claude, Codex, Hermes, OpenCode and Pi ordinary personal Chat and Matrix Terminal execute the existing matrix routines CLI. Native Pi and managed matrix_pi are separate offered routes. Canonical Matrix Bot remains the sole scheduled executor. No documentation/execution MCP, crontab, legacy manage_cron or duplicate routines backend.

## Approved target and authority model

On first use the owner explicitly selects an existing canonical private direct Bot Chat and may remember it as the default for this owner+Computer. All five source harnesses use the same route resolver. A valid default is reused without repeated target confirmation. Active target switching, invalidity or ambiguity requires an owner choice; no first/latest Chat or cross-owner/server fallback.

A routing preference contains destination references/revision and no bearer, action scopes, model grants or activation approval. Each call separately proves its actual current source run/native turn or Terminal launch/session/incarnation; checks owner+Computer, ACL, private/direct/active Chat, live Bot/binding, source lifecycle, action scope and mutation revision. A model-provided ID/configuration is a selector, never authorization. Default preference revision and target are pinned per request; already admitted work cannot silently move when the default changes.

list/show require current read permission and no repeated target picker. propose requires current proposal authority, a real target canonical task and already valid supported background source; returns pending human approval, never active. pause/resume/archive require current control authority and existing action policy, not a new permanent permission inferred from a remembered destination. A missing action scope fails closed or enters the existing exact action approval channel. Routine activation approval, background model grant and integrations remain independently checked. Resume respects exact original bindings and refuses archived/uncertain state.

No source or target BotRuntimeBinding is fabricated. Ordinary source Chat remains on its harness; target task/run comes from canonical Matrix Bot admission. Actual source and target identities remain distinct. Keep A's ENG-93 methods as the source of approval/persistence/scheduling/cancellation semantics; safe DTOs do not expose internal identity/account/grant refs.

## Source and wire boundaries

Internal RoutineCliSourceContext is host-created with ownerId, computerId, harness (claude/codex/hermes/opencode/pi), source kind/chat run or Terminal or existing Bot-child identifiers, source generation/lifetime and actions (read/propose/control). No public CLI request accepts those identity fields.

CLI verbs: routines propose --input - --request-id <uuid>, list, show <routineId>, pause/resume/archive <routineId> --revision <n> --request-id <uuid>, request <uuid>; --json follows current v1 envelopes. No --owner/--chat/--bot/--run/--grant/--account/runtime override or generic token/profile fallback. Terminal/network credentials never enter startup argv, shell history/config, restore state or shared daemon environment.

## Persistence and dispatch

Use owner-controlled Postgres/Kysely for request/receipt and app routing-reference state; no new database engine. The saved route is owner app navigation state referencing canonical Chat/Bot records, not credential/identity configuration. Keep exportable safe config projection separate from runtime secrets. Preference updates use optimistic revision in the write and serialize related target checks/writes. Reads never return another owner/Computer's preference.

Each mutating request has a durable owner+Computer+clientRequestId key, immutable payload/source/target snapshot, revision and explicit applied/pending/unknown disposition. Same key cannot dispatch again, including restart/new-source attempts; changed digest conflicts. External cancellation/model/network work stays outside transactions. Successful pause/control means durable state requested/applied, not proof worker/effects stopped. Preserve uncertain and requiresReview.

## Authentication matrix

- Owner remember/change/reset route: authenticated owner UI operation, scoped owner+Computer, revision and target validity; no routine/source bearer may create preference or permissions.
- CLI read/propose/control/reconcile: live host-issued source capability + exact per-action scope + resolved target checks; never a generic owner-token proxy.
- Target canonical dispatch: real task/run admission and correlation; not client-selected IDs.
- Human routine activation: existing ENG-93 owner/responder/revision approval.
- Native background consent and integrations: existing explicit owner sources only.

All mutating routes need bodyLimit; params/bodies strict Zod; external fetch timeout/no redirects; safe bounded output; registries/temp files capped and cleaned/drained. Shared/org/plan/review cannot inherit private mutation capability. Revocation and source/dispatch consume use the same serialized source-generation gate.

## Required acceptance

Each of five Chat and five Terminal entries must prove actual packaged CLI invocation and real canonical target linkage; native and managed Pi must both be qualified where offered. No fixture/negative-only test stands in for live integration. Missing hooks are unfinished, not N/A. Test stable defaults across harness changes, absent/revoked scopes, removed/deleted/archived/shared/foreign target, stale revisions, concurrent target/authority changes, no fallback, idempotency, cancellation and unknown results.

Native constraints remain: Codex per-turn app-server scope; Hermes actual command child channel and real Terminal launch addition; OpenCode pure/read-only native hook; Pi native owned tool and managed worker->host actual CLI; existing delegated Claude's disabled Bash. No arbitrary Bash enablement or new four native Bot executor products.

## Dependency and evidence

Integrated backend target: Draft #3041 e43ca79412df8562b9e12fb3a5fac3134c522170 over #3019 ea76546f23349d1869a7554d812825999b778e47. Initial B baseline 3db08492b9074606eac2213b9d86c0f58581d685 is historical. Old source tests/media do not qualify new B code. A owns its GUI window; do not use it. Native real-account tests/permissions/background execution require specific further authorization.

Future dependency supplied by the coordinator: Draft #3054 at d9e783116108d3789973cbd16fbf6795850f21a7 over #3041 e43ca79412df8562b9e12fb3a5fac3134c522170 includes the earlier local e22d5a19d7173d961a7aca9385d0ac2e8b77ad66 routine-stage evidence and pause/cancel/lease guards. It is not integrated here. Supplier reports 196 relevant regressions and 71 native PostgreSQL cases, including four compiled-process model fixtures; these are not live model calls. Current-head Host/live, product CI and Greptile 5/5 remain unqualified. Unchanged clients do not make old 3db Host live evidence valid for this backend. Review the final fixed diff before future integration, especially routine-execution/task-orchestrator/stage/cancellation seams; do not automatically change B's base.

Reference T3 at 80a2351fcb909034e65a512dfabeb3cdfd367762: internal target inheritance is separate from live caller and write ceilings. Do not import its local full-access assumptions or MCP execution transport. Matrix's five-harness/remote-owner security remains its own requirement.

## Draft split

B1 remembered target/strict source-action policy/owner route APIs, durable receipts and canonical service adapter. B2 existing CLI/packaging/output. B3 Claude/Codex/Hermes real Chat entry. B4 OpenCode/native+managed Pi restricted real CLI entry. B5 five Terminal launches/credential isolation. Each includes failure-first tests and scoped review. Small public docs Draft in the private site repository is tracked separately; no Nima discovery/skill duplication.

Task 5a execution details and version-bound qualification limits: [Claude source boundary](./claude-sources.md). Other harness cells remain required.

Task 5c execution details and separate native qualification gates: [Hermes source boundary](./hermes-sources.md).

Task7c canonical Terminal entry, current configuration limits and CLI/lifecycle semantics: [Terminal entry boundary](./terminal-entry.md). Required Task7d private native configuration handoff remains implementation work; normal-menu routine availability is not claimed.

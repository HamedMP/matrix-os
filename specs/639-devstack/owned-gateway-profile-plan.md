# Trusted Owned-Node Profiles in Gateway

> Execute task by task with subagent-driven-development; source and actual native acceptance remain separate.

**Goal:** Admit the configured owned-Node runtime through ordinary Gateway and persisted shared-Chat authorization while preserving exact legacy and cross-namespace isolation.

**Source:** ENG-432, DevStack#3023; owned Node#3181. Research: controller-owned ignored gateway-integration-research.md under the owned-node SDD workspace. Current owned mode is deliberately refused by legacy catalogs. This is a required Stage2 dependency, not a relaxed matcher.

## Global Constraints

- No Trellis, Main/installedDev/production changes, newVPS, merge, paid provider or external messages. Preserve live85aa/localthreeworktrees and prior source receipts. Tests use stubs and dedicated syntheticPG only.
- Only canonical server-owned host configuration may select expected digests. Reuse runtimeProfileIdentity on a closed set of the three fixed IDs. Never learn trust from request data, stored scope, client capability, arbitrarydigest/root, environment digest allowlist or process-global mutable registry.
- One immutable policy per configured deployment; dependency injection. Two concurrent test namespaces must not influence each other. No dual legacy+owned digest acceptance in one policy. Unconfigured compatibility exports/defaults remain legacy-only.
- Preserve exact client matching, fixed profile identity/version/workload/harness/adapter/sandbox/UID constraints, and distinct recipeBot/managedPi bases. Preserve generation, binding, selected-driver, lease and Instance fences. No fallback to installed/legacy runtime after invalid namespace or source failure.
- Existing data is reconciled through the existing locked capability transition; no bulk rewriting profile fields or trusting malformed stored values. Unsupported current proof clears eligibility. Preserve revisions/events and owner data.
- New logic in focused modules. Large shared-ai-runtime/queue/Gateway composition edits require extraction plus mechanical pass-through, not new large conditional blocks.
- Manual worktree/nativeghstack dependentPRs, TDD, English online content, separate sitePR. EachPRhardcap50files/3000additions, aim20/1000. No concurrent implementers.

## Task 1: Derive one strict deployment policy

Own focused Gateway profile-policy module, factored eligibility schemas/helpers and catalog factories, their focused tests. Use canonical ScopeRuntimeHostConfig.ownedNode and existing reviewed identity function; do not duplicate hashing. Policy exposes expected fixed catalog, strict shared Chat/managedPi eligibility parsing, driver support and equality including optional matrixBot. Default wrappers retain current legacy exports/call signatures for unconfigured consumers. No unknown-profile fallback (identity helper defaults unknownIDtoChat, so explicitly enumerate knownIDs).

TDD: all3correct owned identities; namespacewithoutoverride/default bytecompatibility; configuredpolicy rejects legacy, arbitrary and othernamespace digests, mixed Chat/Pi identity, wrongsandbox/harness/version/adapter/Instance andduplicateadapters. Two policies cannot leak configuration. Equality detects matrixBot-only appearance/loss even with unchangedgeneration. Tests provebehavior, not object-shape snapshots only. Commit/report, independent review beforeTask2.

## Task 2: Thread trusted policy through admission and persisted authorization

Own startup/suppliedhost/absenthost Gateway wiring, sharedAI runtime extraction, ChatScope/queue/execution-adapter/Slack parser propagation and focused integration/PGtests. Startup resolves canonical config once, creates policy, passes the same immutable policy to owning services. Direct supplied-host construction defaults to legacy unless explicitly paired with a trusted configured policy; capability itself cannot construct that policy. Invalid/mismatched supplied placement fails before workload dispatch. Preserve older legacy tests/callers through explicit compatibility defaults; no module-import env caching.

Use policy at every existing authorization boundary: scope cached capability/newscope creation/reconciliation; queue admission/claim; chat execution adapter; shared runtime dispatch comparisons; Slack thread persistence when enabled. Extract common normalized equality including matrixBot; don't leave static literal checks in owned production paths. Reconcile historical legacy/crossnamespace eligibility only from currently qualified local capability, transactionally maintaining revision/events; repeat idempotent, failed proof clears. Preserve immutable request/generation/driver/Instance fences through transition, and prove rejected old/mixed-namespace authorization cannot become valid simply by equal untrusted fields.

TDD: realUnixsupervisor+realGatewayhost/client acceptsconfiguredowned catalog and dispatches boundedstub request; legacycatalog negativecontrol stays; everyprofile exactcrossnamespace/mixed-mode rejection withzero start. Startup and supplied/absenthost consistency. RealPG existingdata transition/idempotence/concurrentcapability update/cachednewscope/matrixBotonly transition and queueadmission+claim mismatches, plus focusedexecution-adapter/Slack propagation. Stubupstream only, no paidcall. Typechecks andappropriatecoveringsuites, commit/report and independent review. ActualfrozenLinux Gateway→worker turn belongs to controller aftersourcegates; fakefixturewiringisnotStage2fullpass.

## Preflight decisions

| Shared interface | Decision |
|---|---|
| Task1policy → Task2services | Immutable explicit dependency, legacy-only default, no mutable globalcontext |
| Suppliedhost → policy | Never infer from capability; normal startup shares trusted policy; omittedpolicy keepslegacyrefusal |
| Reconciliation → queue | Preserve existing atomic transition and all runtime/selection/Instance fences; test negative authorization across policychanges |
| Scopeequality → managedPi | Common normalizedequality includes matrixBot; unrelatedBotfeaturechangesoutofscope |

No user product decision is blocked. If concrete code reveals authorization semantics absent from these contracts, controller records a bounded ruling before implementation. Gateway actualacceptance and monetaryprotocol are both required before Stage2usableclaim.

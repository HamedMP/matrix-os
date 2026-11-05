# Operator Probe Budget Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task; the controller owns private allocation and target qualification. Steps use checkbox syntax.

**Goal:** Enforce a persistent dollar limit and one-dispatch accounting for paid readiness probes across local and Stage2 control planes.

**Architecture:** A dedicated lifetime wallet and immutable attempts in Postgres expose one authenticated authority. Platform callers use a local or remote store; Relay dispatches only after atomic begin and reports exact usage. Platform derives readiness from the authority's committed row. Keep this independent of user grants, cache TTLs and monthly policy counters.

**Tech Stack:** Node24, TypeScript/Zod4, Hono, PostgreSQL/Kysely, existing reviewed Relay pricing/usage helpers, Vitest.

**Spec:** `specs/639-devstack/operator-probe-budget.md`, DevStack specification PR3023, ENG432.

## Global Constraints

- Follow the budget contract above, project constitution and security/transaction rules; all API mutations use bodyLimit plus strict bounded schemas. No new ORM or embedded store.
- No Main mutation, production rollout, new VPS, merge or messages. Preserve installed Dev and three local worktrees. No customer refill/reset or old-credential import.
- Historical probe cost is unknown; retain its reserve/flag and never claim retrospective $10 enforcement. Prospective probe availability is $5.25 within the configured original envelope.
- Use manual worktrees, TDD and native GitHub stacks for dependent layers, English online content, separate site docs, and per-PR size limits. No Trellis creation; user declined.
- Preserve production defaults until explicitly configured. Old Sonnet Chat stays on the pinned serving Relay; no new Anthropic key/counting dependency.
- Keep source/receipt provenance per component and native target. No provider call during code tests. Unknown post-begin liability never auto-releases.

## Review Focus

1. Duplicate/lost begin acknowledgements must never dispatch twice, including across replicas or a new execution ID.
2. Concurrent reservations, finalize retries and expired caches must not restore money or exceed the same lifetime wallet.
3. Missing/negative health evidence cannot erase known cost or turn unpriced work into a free probe.
4. Legacy protocols, mismatched models/prices and wrong service credentials must fail before upstream work.
5. Control-plane placement/forwarding changes must not change ordinary Chat authority or select Main.

## Task 1: Lifetime repository, contracts and authority

**Files:** create `packages/contracts/src/funded-operator-probe.ts`; add its package subpath export. Create focused `packages/platform/src/operator-probe-budget/{repository,migration,database,routes,main}.ts` (each below500LOC), database types/own migration registration as needed. Add `tests/platform/operator-probe-budget{,-postgres,-routes}.test.ts` and contract tests.

**Interfaces:** export `OperatorProbeBudgetStore` with async `begin(input)`, `finalize(input)`, `getAttempt(probeId)` and `getStatus()`. Repository factory `createOperatorProbeBudgetRepository({db,budgetId,now?})`; explicit `initializeOperatorProbeBudget(db, config)` is insert-if-absent/exact-replay-only, never a startup refill. Wallet identity is fixed configuration, not a request-chosen key.

Store validated wallet allocation, historical reserve/unpriced flag, held/settled amounts, enabled/expiry/revision/source and reviewed model policies. Each policy pins canonical/native IDs, pricing version/expiry, input/output ceilings, fixed fingerprint, integer thousandth-microUSD rates and a conservative maximum. Compute quoted/actual microUSD with integer arithmetic and bounded safe-number conversion; seeded quotes must cover the existing full-context/cache-risk120% estimator. Attempts store the complete original policy and economic payload hash, first execution ID, status/outcome, normalized usage/cost or unresolved liability and immutable receipt hashes.

`begin` atomically creates a started attempt and maximum hold. Return dispatch permission only on that insert/transition, never as a replayed saved success. `finalize` accepts only matching execution/economic identity; recomputes cost from stored rates; exact duplicate returns stored receipt, changed duplicate conflicts. Known cost+not-ready still settles; unknown retains hold; over-bound reports freeze the wallet and retain discrepancy. Finalize can resolve a matching unknown attempt later, even after admission price/budget expiry. No attempted-start TTL refund. Cap retained attempts at10000 per wallet, under the same wallet lock.

Authority API base `/ai/operator-probe-budget`: strict POST `/begin`, `/finalize`, `/attempt` and read-only GET `/status`, all authenticated by `MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN` (at least32chars) and configured budget ID. Body max16KiB, no URL/caller wallet override. The standalone main binds configured literal loopback with a dedicated required PG URL and no customer workers/Clerk/provider keys. It initializes only its additive migration scope, owns/destroys its pool, and never seeds a spending allocation. Full Platform migration registration uses the same additive scope and must not skip it because core schema is newer.

- [ ] RED: budget races, one begin grant, exact/changed replay, restart/rollover, expired pricing, negative/unknown/over-limit usage and immutable historical settlement.
- [ ] Implement contracts, focused migration/types, transaction repository and authenticated authority using existing DB/HTTP patterns.
- [ ] Prove real-PG independent pools, old/new schema marker admission, partial-failure rollback and lifetime persistence. Test API auth/body/range/unknown fields before store access.
- [ ] GREEN appropriate suites/typechecks; commit and report exact commands/results. No actual wallet activation or provider call.

## Task 2: Platform/Relay protocol, shared store and truthful readiness

**Files:** extend `packages/platform/src/ai-funded-model-probes.ts`, startup wiring and existing control-route registration through focused modules; create an authenticated local/remote store adapter under `operator-probe-budget/`. Extend Relay config/app/control-client and add focused `packages/proxy/src/operator-probe-{price,execution,usage}.ts`; reuse existing model/usage/Workers helpers. Add relevant Platform/Relay contract, integration and failure tests. Avoid adding behavior to existing1000+LOC files; extract registration if necessary.

**Interfaces:** `MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID` enables required monetary mode in Platform; optional `MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_URL` and required authority token select the remote store, otherwise local DB. Add explicit `MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL` separate from the ordinary inference Relay URL. Relay `MATRIX_AI_RELAY_OPERATOR_PROBE_BUDGET_REQUIRED=true` requires protocol1 and rejects legacy paid GET before upstream; undefined retains production behavior.

Platform assigns a UUID and POSTs protocol1/model/probe ID only to source Relay. Relay constructs fixed nonstreaming ping, disables gateway cache/retries/payload collection with fixed provider headers, and calls its own Platform control-auth begin/finalize facade; Platform delegates to its configured authoritative store. Relay sends no caller body/token limit. Price policies are exported from existing reviewed catalog/rate helpers; compare quote results with `estimateWorstCaseMicrousd` at full model context and maxOutput1 (Sonnet4800012microUSD; GLM235930 with current reviews). No optimistic fixed-token/no-cache estimator.

Relay must capture bounded complete usage/terminal/model evidence, including Sonnet stop_reason and normalized GLM envelope/finish_reason. Store trusted normalized usage at pinned prices. Persist payload-free pseudonymous provider probe_ref and any returned existing provider log reference; never log prompts, bodies, keys or owner IDs. After Relay completion/error, Platform reads the authority attempt; only matching settled successful health with current pricing can yield ready. Use a new protocol/budget cache namespace, bound expiry by price and wallet validity, retain count quotas and owner-funded Jev semantics, no fallback old GET/Relay/no-receipt response.

Bound control RPCs to3s each, monetary upstream probe to18s and Platform's Relay request to25s; authoritative readback max2s, within existing29s Platform route. Every fetch has an abort timeout/no redirects; settle known expense with a bounded finalization tail even when the caller disconnects. Drain owned in-flight tasks on shutdown and keep all registries bounded.

- [ ] RED: old/invalid protocol never fetches; two replicas/sameprobe grant one dispatch; all crash/acknowledgement-loss boundaries retain liability.
- [ ] Implement authenticated facade/remote store, fixed Relay lifecycle and DB-derived Platform readiness. Remote non-loopback requires HTTPS; only explicit loopback placement permits HTTP.
- [ ] Prove negative known-cost settlement, missing/over-bound usage, expired admission and retained settlement versions, pricing/cache/authority rotation, Jev/default compatibility and zero fallback.
- [ ] Real-PG local+remote HTTP integration with stub upstream proves one wallet, exact settlement, replay and shutdown; no real provider. GREEN/typecheck, commit/report.

## Task 3: Target-safe forwarding and operational handoff

**Files:** repair `packages/sync-client/src/cli/port-forward.ts` explicit-route URL joining with owning tests. Add focused operator bootstrap/diagnostic tooling and repository docs, keeping real config/identifiers outside the repo. Update the separate site documentation PR.

`createForwardWebSocketUrl()` must preserve any explicit `/vm/<handle>/~runtime/<slot>` base path while retaining host-root behavior; reject credentials/query/fragment or ambiguous paths using existing URL conventions. Never print bearer query tokens. An inward authenticated forward is supported; do not invent reverse forwarding.

The controller prepares the dedicated loopback budget authority on existing Dev with private DB/token, no installed-service mutation, using reviewed exact source and existing authenticated operator transport. Mac and Dev callers share that wallet through the same store. Validate authority identity through the forward before enabling spending. Historical individual probe cost remains unknown; refresh the broader usage audit before activation and keep its conservative reserve separate from actual settled cost. Reduce old-pilot effective cap8.4->2.25USD first and account for in-flight work, then bootstrap allocation6.25USD including1000000microUSD historical reserve, making5250000microUSD available. Keep alpha/beta/gamma500000 each, no refill/reset; later Stage2 customer allocation is reallocated from pilot first. Disable/drain legacy probes before activating required protocol, while preserving old Sonnet Chat selection.

- [ ] RED/GREEN URL joining and wrong-target regression; no default-profile mutation.
- [ ] Verify owned source/DB/namespace/ports, protected configs, startup/stop/restart and idempotent bootstrap; never seed money on service start.
- [ ] Controller runs stub monetary gates first, audits the real configured envelope, then only bounded positive paid probes/Chat and reconciles exact wallet/customer results. Record uncertainty separately.
- [ ] Capture source/lockfile/config-name/version receipts and actual Dev/local peer invariance. Publish linked PRs/native stack with invariants and separate site docs; do not merge or claim complete Preview/shared-Linux qualification.

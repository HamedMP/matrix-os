# Implementation Plan: Prebilling Provisioning

**Branch**: `116-prebilling-provisioning` | **Date**: 2026-08-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/116-prebilling-provisioning/spec.md`

## Summary

Move new-primary VPS preparation into the payable-checkout window: after the signed-in user has selected compute, region, and developer tools and explicitly continues, the existing checkout mutation creates one owner-bound preparation intent and starts the existing durable provisioning pipeline. The prepared machine may become physically ready but remains unreachable until the existing signed, exact-slot subscription projection atomically authorizes it. Authoritatively expired unpaid preparations are reclaimed through a separately leased and revision-fenced cleanup workflow; successful billing always guarantees a prepared machine or one normal entitlement-backed provisioning job without another browser click.

## Technical Context

- **Language/Version**: TypeScript 5.5+ strict ES modules on Node.js 24+
- **Primary Dependencies**: Hono 4, Kysely 0.28, Stripe SDK 22/API `2026-04-22.dahlia`, Zod 4 via `zod/v4`, Next.js 16, React 19
- **Storage**: Platform PostgreSQL through Kysely; Stripe and the existing VPS provider are external systems of record for their own lifecycle
- **Testing**: Vitest 4 unit/integration/contract suites, fake Stripe/provider full-path tests, shell production build, React Doctor, then an explicitly approved disposable-VPS validation
- **Target Platform**: Cloud Run platform/app-shell control plane coordinating VPS-native per-user Linux runtimes
- **Project Type**: Monorepo web application with platform backend, Next.js shell, and VPS lifecycle services
- **Performance Goals**: Reduce median subscription-authorization-to-ready latency by at least 60%; 80% of users spending at least 60 seconds in checkout ready within 20 seconds of authorization
- **Constraints**: Zero access before signed slot entitlement; zero duplicate active intents/machines; 30-minute Stripe/preparation policy plus one-minute API safety headroom; 99% cleanup by 35 minutes and 100% by 45 minutes outside provider outage; one hard global active-count ceiling across all offered machine sizes; generic client errors; all external calls bounded
- **Scale/Scope**: V1 new-user primary-computer onboarding only; horizontally scaled platform workers; existing paid, additional-computer, recovery, resize, preview, grace, suspension, and self-hosted flows unchanged

## Constitution Check

*GATE: Passed before research and rechecked after design.*

| Principle | Design evidence | Status |
|---|---|---|
| Data belongs to its owner | Machine is bound to the initiating owner from creation, never pooled/reassigned, and abandoned owner data/secrets are deleted; only minimal billing/security audit history remains | Pass |
| AI is the kernel | Agent selection remains a durable onboarding input and existing runtime installation/kernel behavior is reused; no new parallel agent runtime is introduced | Pass |
| Headless core, multi-shell | Preparation, activation, cleanup, and journey state are platform-owned contracts; Canvas/Desktop render the same server state | Pass |
| Self-healing | Durable jobs, leases, exact provider reconciliation, signed-event replay, capacity repair, and cleanup continuation recover from restarts and ambiguous external calls | Pass |
| Quality over shortcuts | No browser-orchestrated second mutation, generic bypass flag, reusable warm pool, or direct provider call from the request path | Pass |
| Defense in depth | [HTTP auth matrix](./contracts/http.md), strict Zod/body limits, bounded calls, dual entitlement/activation gates, worker DI, revision fences, and full-path integration tests are specified | Pass |
| TDD | Every implementation slice begins with failing focused and integration tests; authorization/cleanup predicates target full branch coverage | Pass |
| PostgreSQL/Kysely | New durable state and global capacity are PostgreSQL/Kysely only; no alternate store or ORM | Pass |
| Worktree/PR/Greptile | Work occurs in a manual persistent worktree and ships as reviewable Graphite PRs with current-head Greptile `5/5` | Pass |
| Public documentation | A separate public-safe `FinnaAI/matrix-os-site` documentation PR is an explicit deliverable | Pass |

There are no constitutional deviations. The post-design recheck specifically confirms that cleanup cannot delete based on a local timer, access has explicit defense-in-depth gates, related transitions are transactional, and the public documentation is not being placed in the monorepo's unrelated local `www/` tree.

## Project Structure

### Documentation (this feature)

```text
specs/116-prebilling-provisioning/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── events.md
│   └── http.md
└── checklists/
    └── requirements.md
```

`tasks.md` is intentionally deferred to `/speckit.tasks`; it is not a planning output.

### Source Code (repository root)

```text
packages/platform/src/
├── db.ts                                      # additive migrations and typed rows
├── billing-routes.ts                          # existing checkout/webhook boundary
├── stripe-billing.ts                          # exact metadata and bounded Stripe calls
├── journey.ts
├── journey-routes.ts
├── app-session-routes.ts
├── request-routing.ts
├── profile-routing.ts
├── session-routing-middleware.ts
├── session-routing-proxy.ts
├── session-routing-websocket.ts
├── platform-websocket-upgrade.ts
├── customer-vps.ts                            # shared machine/job creation orchestration
├── customer-vps-provisioning-jobs.ts          # durable provider worker
├── prebilling-provisioning-config.ts          # planned bounded config/rollout parsing
├── prebilling-provisioning-store.ts           # planned Kysely state transitions
├── prebilling-provisioning.ts                 # planned orchestration service
├── prebilling-cleanup-actions.ts               # planned cleanup worker/state machine
└── prebilling-provisioning-telemetry.ts        # planned bounded metrics/events

shell/src/
├── components/BootSequence.tsx
├── components/settings/sections/BillingPanel.tsx
├── lib/billing.ts
└── lib/provisioning-handoff.ts

tests/platform/
├── billing-db.test.ts
├── billing-routes.test.ts
├── billing-settling.test.ts
├── stripe-billing.test.ts
├── journey.test.ts
├── journey-routes.test.ts
├── customer-vps-provisioning-durability.test.ts
├── customer-vps-reliability.test.ts
├── app-session-runtime-routing.test.ts
├── proxy-routing-billing.test.ts
├── session-routing.test.ts
└── prebilling-provisioning.test.ts             # planned focused state/full-path suite

tests/shell/
├── billing-gate.test.tsx
├── billing-panel-preselect.test.tsx
└── prebilling-onboarding.test.tsx              # planned Canvas/Desktop journey suite
```

**Structure Decision**: Keep the feature inside the existing platform and shell packages. Extract new focused state/worker modules instead of adding behavior to already-large billing and customer-VPS composition files. Reuse the established checkout, signed subscription projection, provisioning-job, provider-reconciliation, snapshot, routing, and journey paths through typed dependency injection.

## Architecture and Invariants

```text
compute + region + agents
          |
          v
POST /billing/checkout --Stripe open session--> durable intent + machine/job
          |                                      |
          |                                      +--> provider preparation
          |                                             (owner-bound, inaccessible)
          v
Stripe-hosted checkout
          |
          v signed subscription event
authoritative subscription projection
          |
          +--> cancel cleanup + authorize exact machine
          |         or ensure one normal provisioning job
          v
runtime routing requires entitlement AND activation_state=authorized

Stripe authoritative expiry + no entitlement
          |
          v
leased cleanup -> recheck/fence -> provider delete -> reconcile absent -> finalize
```

Non-negotiable implementation invariants:

1. **Billing source of truth**: only the existing verified subscription projection for a recognized Price and exact runtime slot authorizes initial runtime access.
2. **Provisioning source of truth**: one durable preparation intent links the immutable selection, checkout attempt, machine, provisioning job, and cleanup revision.
3. **Access gate**: all customer routing/operation paths require both effective entitlement and `activation_state=authorized`; physical `running` is insufficient.
4. **Owner and slot lock scope**: unique active checkout/intent/machine constraints plus transactional owner/slot locking make retries converge.
5. **Cleanup lock scope**: lock intent, cleanup action, machine, current entitlement projection, and newer owner/slot intents in one documented order before the irreversible phase transition.
6. **Acceptable orphan states**: an open checkout with no preparation is safe and falls back after authorization; an unauthorized prepared machine is temporarily acceptable only under an active lease/cleanup action; an authorized slot with no live machine is acceptable only with one durable normal provisioning job.
7. **Provider ambiguity**: deterministic provider identity/labels are reconciled before create/delete retry; terminal cleanup means confirmed provider absence.
8. **Rollback**: disabling admission stops new unpaid preparation but continuation workers keep authorization, fallback provisioning, reconciliation, and cleanup alive. The legacy reservation column remains present and is written as zero so reverting needs no schema migration. A rollback to the former cost-aware binary retains the same `MAX_ACTIVE` count fence, so transitional exposure never exceeds the accepted count-only bound. To restore the former monetary ceiling immediately, operators MUST disable admission on the count-only revision and wait one 31-minute lease or verify that no active unpaid zero-valued reservations remain before shifting traffic and restoring the legacy cost settings.

## Implementation Sequence

### Commit 1 — Flag-off persistence and lifecycle foundation

Write failing database/state tests, then:

- Add the intent, activation, authorization-basis, cleanup-action, and capacity-bucket schema from [data-model.md](./data-model.md), with rollback-safe defaults and constraints.
- Implement strict configuration parsing for enabled state, deterministic rollout/allowlist, active count, worker leases, and bounded retry/timeout values. Admission is independent of machine size and legacy cost settings.
- Extract transaction-aware Kysely stores. Repository wrappers accept a transaction handle and never destroy shared pools.
- Extend the shared machine/job creation path with a narrow discriminated authorization basis. Keep the existing public entitled provision method unchanged.
- Add activation checks to every runtime/customer operation path in the auth matrix before the feature can create `awaiting_billing` machines.
- Add the cleanup worker with recurring leased claims, shutdown drain, bounded retries, Stripe reconciliation, exact provider deletion reconciliation, and local-secret cleanup.
- Register all worker dependencies at startup and verify the worker-enabled Cloud Run role owns timers/resources and destroys only resources it created.

Exit gate: admission remains `0%`; migrations, activation regression tests, job authorization checks, cleanup state tests, worker startup/shutdown tests, and existing lifecycle suites pass.

### Commit 2 — Checkout, Stripe projection, and server-owned fallback

Write failing checkout/webhook/race integration tests, then:

- Extend the existing strict checkout schema/client call to include canonical developer tools and server type; correct active-attempt selection equality.
- Claim the checkout attempt and opaque intent ID before Stripe so both metadata scopes carry the exact ID. Do not start provider work until an open session is durably finalized.
- Reconcile ambiguous Stripe Session creation against the durable attempt/idempotency identity.
- In the checkout-finalization transaction, admit capacity and create the machine/job once. If preparation admission is unavailable, return the safe checkout destination with zero provider calls.
- Extend signed subscription projection processing to validate the exact local binding, cancel cleanup, authorize the prepared machine atomically, and replay idempotently.
- In that same server-owned projection workflow, guarantee an entitled primary slot has its valid prepared machine or exactly one entitlement-backed provisioning job. This removes the post-payment browser-click dependency even when prebilling is skipped or fails.
- Handle event reordering: a subscription projection may arrive while checkout finalization is reconciling; either transaction must leave the authorization guarantee true after replay.

Exit gate: fake Stripe/provider full-path tests pass, including completed-without-subscription quarantine, authorization in every cleanup phase, stale expiry, duplicate retries, capacity denial, provider ambiguity, and paid-without-machine fallback.

### Commit 3 — Journey, shell, observability, and rollout controls

Write failing journey/UI/telemetry tests, then:

- Extend journey with optional coarse preparation state and `resume_checkout`; keep existing consumers compatible.
- Move developer-tool selection before checkout for the eligible new-primary cohort. The explicit button opens checkout and preparation in one mutation; no separate browser provisioning request exists.
- Render preparing, ready-waiting-for-billing, payment-settling, authorized-provisioning, safe failure, and ready states using `@matrix-os/brand` primitives. Keep all provider/internal details out of UI state.
- Guard active-document/account changes and multi-tab retries by always refreshing authoritative journey state after ambiguous client outcomes.
- Add the event/metric contract, dashboards, baseline cohort comparison, active-count/cleanup alerts, and an operator admission kill switch that leaves continuation workers running.
- Validate Canvas first, then Desktop; ensure mobile or older clients using the stable checkout response continue to function.

Exit gate: shell build/React checks, UI contracts, coarse-error checks, metric cardinality tests, and the complete existing onboarding/billing suite pass with admission still disabled by default.

### Separate public documentation PR

After the implementation contract stabilizes, update `FinnaAI/matrix-os-site/content/docs/` in a separate worktree/PR. Explain compute → agents → secure checkout/preparation → billing authorization → ready and what happens if checkout is abandoned. Keep provider identities, infrastructure details, private identifiers, and operator procedures out of public docs.

## Security and Failure Design

- Apply `bodyLimit` before parsing every touched mutating route and use strict Zod discriminated/route schemas.
- Preserve Stripe signature verification and bounded raw webhook bodies; event IDs make replay idempotent.
- Every Stripe/provider `fetch` or SDK call has an explicit timeout. Provider errors are logged and normalized before reaching route/journey/UI state.
- Never use raw `X-Forwarded-*`, `Host`, IP, or client identifiers for admission. Per-origin enforcement must be configured at a trusted edge; durable account/global controls remain authoritative in Postgres.
- Do not expose a generic `skipBilling`, preview flag, internal preparation route, or machine identifier to the browser.
- Leases are finite and reclaimable; timers/registries have caps, recurring cleanup, and explicit shutdown drains.
- A failed preparation cannot cancel or downgrade a valid subscription. A failed/late billing event cannot resurrect deleted provider state; it creates a normal entitled job.
- A later subscription cancellation or grace transition follows the existing billing runtime-action policy; prebilling adds no new cancellation semantics after authorization.

## TDD and Verification Strategy

The detailed matrix is in [quickstart.md](./quickstart.md). Implementation follows red → green → refactor per stack and includes:

- Unit tests for schemas, canonical selection equality, count-only feature config, transition predicates, capacity accounting, and safe error mapping.
- Kysely integration tests for unique constraints, transaction rollback, concurrent claims, optimistic revisions, event replay, capacity release-once behavior, and migration defaults.
- Full fake-service integration for checkout → preparation → physical ready/inaccessible → signed subscription → activation/routing.
- Exhaustive billing-cleanup interleavings at every irreversible phase and ambiguous provider create/delete reconciliation.
- HTTP and WebSocket access-matrix tests covering session routing, explicit VM route, app session, runtime REST/API, code domain, terminal, recover, resize, and resume.
- Regression tests for existing paid provisioning, additional computers, preview, recovery, resize, grace, suspension, and billing resumption.
- Shell tests for selection ordering, one-mutation checkout, safe progress, refresh/multi-tab resumption, account changes, Canvas-first rendering, and Desktop compatibility.
- Coverage and production shell build before exact-head preproduction validation.

## Rollout and Operations

1. Deploy additive schema, activation gates, and continuation workers with admission disabled.
2. Prove startup ownership, cleanup draining, metrics, and repair reconciliation in the worker-enabled revision.
3. Soak fake/synthetic traffic, then—only with explicit operator authorization—use Stripe test mode and one disposable VPS for exact-head full-path validation.
4. Enable deterministic internal allowlist, then `1%`, `10%`, `50%`, and `100%`, holding at least one cleanup window and checking the success/stop metrics at every stage.
5. Compare against a stable postbilling control cohort for authorization-to-ready latency, conversion, provider failure, cleanup lag, and paid-without-machine incidence.
6. Set admission to zero immediately on an invariant, active-count, duplicate, cleanup, or latency stop condition. Existing intents continue to authorize or clean up.

The platform/app-shell deployment path is used for this change. Production customer runtimes remain VPS-native; no Docker Compose deployment or fleet host-bundle rollout is implied by this plan.

## Delivery Shape

- One implementation PR with three reviewable phase commits, each safe with admission disabled. Stop and split before publication if the aggregate diff exceeds 3,000 additions or 50 files.
- Conventional Commit titles and bodies containing source of truth, transaction/lock scope, acceptable orphan states, auth source of truth, and deferred scope.
- Current-head CI and trusted Greptile `5/5` on every PR; all material findings fixed or explicitly deferred with a linked issue before merge.
- Separate `matrix-os-site` documentation PR, also reviewed to the repository's required gate.

## Deferred Scope

- Additional-computer prebilling, operator previews, recovery, resize, self-hosted runtimes, and warm/reusable pools.
- Agent authentication or running user agents before billing authorization; only tool IDs are selected precheckout.
- Pricing, trial, grace, cancellation, suspension, and payment-recovery policy changes.
- Provider failover that changes a user's selected region or compute shape.
- Customer-facing machine resize or plan-change UI.

## Complexity Tracking

No constitution violations require justification. The deliberate added complexity—a dedicated intent and cleanup state machine—is required because checkout, provider lifecycle, and signed access authorization can race independently; reusing a billing status or unfenced deletion queue would not preserve the access and deletion invariants.

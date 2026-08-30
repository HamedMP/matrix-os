# Implementation Plan: Matrix-Funded AI and Provider Accounts

**Branch**: `codex/ai-gateway-provider-auth` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/118-ai-gateway-provider-auth/spec.md`

**Decision status**: Approved. Cloudflare AI Gateway Unified Billing is the funded upstream; Matrix owns model policy, per-owner balances, and add-on credits.

## Summary

Give eligible Matrix users a working AI kernel without BYOK by placing a Matrix-controlled, Anthropic-compatible relay between each owner VPS and Cloudflare AI Gateway Unified Billing. Keep the shared upstream credential only at the relay; authenticate every runtime with a scoped/revocable service credential; disable payload logging; allowlist funded models; and ship the first version without a user-visible allowance while retaining global budget, rate, concurrency, size, telemetry, eligibility, and kill-switch controls.

In parallel, update the Claude Agent SDK through real-runtime spikes, publish the current Anthropic model catalog, and replace the misleading single Anthropic auth badge with a canonical provider snapshot that separates harness, model provider, account, access source, and model. Add OpenRouter OAuth PKCE and the best officially supported Anthropic login flow behind that same contract. Metering/add-ons and extra ACP harnesses are later additive phases.

### Current implementation checkpoint

The staged work through Phase 2 provides the default-off Cloudflare transport
boundary plus a read-only V3 snapshot and compatibility projections for Chat
and Settings. It does not enable funded AI on production VPSes, complete the
shared **Agents & providers** redesign, mutate provider accounts, issue the
production runtime-scoped relay credentials, or create the Postgres credit
ledger. Those remain separate TDD slices below so the secret-bearing relay,
account lifecycle, shell convergence, and commercial billing are reviewed
independently.

## Technical Context

**Language/Version**: Node.js 24+, TypeScript 5.5+ strict, ES modules
**Primary Dependencies**: Claude Agent SDK V1 `query()`/`resume`, Hono, Zod 4 (`zod/v4`), Kysely, PostgreSQL, Next.js 16, React 19, Cloudflare AI Gateway, OpenRouter OAuth/API
**Storage**: owner configuration/secret files for provider credentials; owner Postgres only if provider account orchestration needs durable multi-instance state; platform PostgreSQL/Kysely for later entitlements, reservations, and content-free usage records
**Testing**: Vitest and `@vitest/coverage-v8`; real Agent SDK spike/integration suite; Hono route/stream integration tests; shell store/component tests; release-parity disposable VPS smoke
**Target Platform**: VPS-native Linux customer runtime, central Matrix relay/control plane, browser/desktop/mobile/channel shells
**Project Type**: monorepo, distributed web/runtime/control-plane system
**Performance Goals**: funded relay adds less than 250 ms p95 time-to-first-token overhead; bounded status refresh under 2 seconds; kill switch effective within 60 seconds
**Constraints**: no funded secret on customer VPS; metadata-only relay/gateway logs; fixed external endpoints with timeouts and redirects rejected; no stateful Agent response cache; 99-100% kernel/gateway coverage target; no SQLite/new ORM; production is VPS-native, not Docker
**Scale/Scope**: all eligible personal runtimes, initial Anthropic funded route, Anthropic/OpenRouter owner accounts, one canonical Chat/provider state across all shells; organizations, pricing, add-ons, and ACP harnesses are staged separately

## Constitution Check

### Pre-design gate

| Principle | Plan response | Status |
|---|---|---|
| Owner data | Chat content stays in owner storage. Owner provider credentials stay in owner-controlled secret/config state and are export-denied as secrets; disconnect/delete remains owner-controlled. Platform retains only control-plane eligibility and later content-free financial records. | Pass |
| AI is the kernel | Funded routing remains compatible with Agent SDK V1 `query()`/`resume`; no renderer-specific AI path or replacement backend logic is introduced. | Pass |
| Headless core, multi-shell | Provider status and account operations live in contracts/gateway services. Chat, Settings, desktop, mobile, and channels consume one projection. | Pass |
| Self-healing / rollback | Last-known-good model catalog, safe fallback, health probes, global kill switch, runtime credential revocation, and direct owner-funded fallback are explicit. | Pass |
| Quality over shortcuts | No shared upstream key is shipped to VPSes; the legacy proxy is rehabilitated instead of promoted as a prototype. | Pass |
| App ecosystem / multi-tenancy | Browser input cannot select owner/billing identity. Org-shared credentials are deferred until org ownership and RBAC are specified. | Pass |
| Defense in depth | Auth matrix, schemas/body limits, timeouts, redirect policy, resource caps, credential handling, safe errors, integration wiring, shutdown, and data flow are specified in `contracts/`. | Pass |
| TDD | Each implementation slice begins with failing unit/contract/integration tests and includes a real SDK spike before dependency/model changes. | Pass |
| Worktree/PR/Greptile | Work is in manual worktree `matrix-os-ai-gateway-provider-auth`; every slice is a Conventional Commit PR with invariants and Greptile 5/5. | Pass |
| Public documentation | A separate `FinnaAI/matrix-os-site` PR is a release deliverable before general enablement. | Pass |

### Post-design gate

- No durable application or control-plane state uses SQLite; later usage work explicitly replaces legacy `better-sqlite3` with platform Postgres/Kysely.
- The initial relay is conversation-stateless; bounded limiter registries have cap, TTL/LRU eviction, recurring cleanup, and shutdown drain.
- All external calls use fixed allowlisted URLs, `AbortSignal.timeout(...)`, `redirect: "error"`, bounded responses, and cancellation propagation.
- Multi-step credential/callback mutations are idempotent and atomic. Later allowance reservation and balance change occur in one transaction with the predicate in the write statement.
- No prompt, response, tool payload, file content, secret, or raw provider error is persisted in routine relay or Cloudflare logs.
- The SDK remains on V1 `query()`/`resume`. Any incompatible finding stops the version/model PR and is recorded in SDK verification documentation.

Result: **pass; no constitution exception required**.

## Project Structure

### Documentation for this feature

```text
specs/118-ai-gateway-provider-auth/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
└── contracts/
    ├── http.md
    ├── provider-catalog.md
    └── relay.md
```

### Expected source changes

```text
packages/contracts/src/
├── ai-provider.ts                  # canonical source/account/driver/model/status schemas
└── canonical-chat-provider.ts     # provider-instance binding compatibility

packages/kernel/
├── package.json                   # verified Agent SDK version
├── src/options.ts                 # V1 options, skills/task tools, model controls
└── tests/                         # first-turn MCP/resume/hooks/subagents/refusal coverage

packages/gateway/src/
├── ai-providers/
│   ├── DOMAIN.md
│   ├── service.ts                 # one provider snapshot source
│   ├── credential-store.ts        # owner secret/profile adapters
│   ├── health.ts                  # bounded probes and TTL/LRU cache
│   ├── connections.ts             # bounded login-attempt coordinator
│   ├── anthropic-account.ts
│   └── openrouter-account.ts
├── routes/ai-providers.ts
├── chat/provider-catalog.ts       # canonical instances/models from service
├── kernel-credentials.ts          # explicit access-source resolution
└── kernel-settings.ts             # catalog-backed current model defaults

packages/proxy/
├── DOMAIN.md
├── src/main.ts                    # composition only
├── src/config.ts
├── src/runtime-auth.ts
├── src/funded-policy.ts
├── src/relay.ts
├── src/limits.ts
├── src/cloudflare-client.ts
├── src/errors.ts
└── tests/

packages/platform/src/
├── orchestrator.ts                # VPS relay base URL + scoped runtime credential
├── ai-funding/                     # policy and later entitlement authorizer
└── db/migrations/                  # later usage/reservation tables only

shell/src/
├── components/settings/agents-providers/ # shared Canvas/Web Desktop feature UI
├── components/settings/sections/AgentRuntimePanel.tsx # migration adapter
├── components/chat/                # account/model/access-source UI
├── stores/                          # serializable provider snapshot/draft restoration
└── lib/terminal-launch.ts           # safe Anthropic CLI fallback

tests/
├── integration/                     # owner gateway -> relay -> fake upstream stream
└── shell/                           # shared derivation/actions + three-surface parity
```

**Structure decision**: keep shared funded request transport and platform usage policy in `packages/proxy`, which already owns shared API proxy/usage concerns, but split its current catch-all implementation into bounded services and document the domain. Owner provider accounts remain in `packages/gateway`; canonical public schemas live in `packages/contracts`; shared shell feature code renders them in Canvas and Web Desktop, while Electron consumes the same contract/derivations through a thin shell adapter. Do not create a second Chat implementation or import `t3code` runtime internals.

## Product Information Architecture and Parity

The normative UI and lifecycle contract is
[`docs/dev/provider-settings-parity.md`](../../docs/dev/provider-settings-parity.md).

- **Harness** is the executable agent runtime. Internal V3
  `ProviderDriver`/`ProviderInstance` values project harness definitions and
  runnable configurations.
- **Model provider** serves inference. **Account** is an owner-scoped login or
  profile. **Access source** is the exact credential and funding path for a run.
- **Agents & providers** owns harness installation/configuration, accounts and
  authentication, routing, models, and truthful usage.
- **Identity & personality** owns Matrix identity and `soul.md`.
- **Custom agents** is reserved for the future `~/agents/custom/` definition
  surface.
- V3 is the sole state truth. Legacy Settings/Chat shapes are projections only.
- Canvas, Web Desktop, and Electron share feature state, derivations, actions,
  and as much component code as practical. Electron Desktop is the visual and
  interaction ground truth during convergence; validation runs Canvas first,
  then Web Desktop, then Electron.

## Architecture and Invariants

### Request paths

```text
Matrix-funded turn:
shell/channel -> owner gateway -> kernel Agent SDK
              -> central Matrix relay -> Cloudflare AI Gateway -> Anthropic

Owner Anthropic turn:
shell/channel -> owner gateway -> kernel/Claude harness -> Anthropic
                                      ^ owner profile or API key

Owner OpenRouter turn:
shell/channel -> owner gateway -> compatible kernel/harness -> OpenRouter
                                      ^ owner OAuth/API key
```

The first implementation does **not** place the platform Anthropic/Cloudflare credential in `/opt/matrix/env/host.env`. It places a runtime-scoped relay credential there (or in an equivalent root-readable service environment file), and the relay replaces it with its central upstream authorization.

### Source-of-truth invariants

- `AiAccessSource` answers who supplies credentials and who is billed.
- `ProviderAccount` answers whether the owner's external account is connected and verified.
- `ProviderDriver` is the internal definition of a harness and answers whether it is installed and what it can do.
- `ProviderInstance` is a runnable harness configuration and binds a driver, one explicit access source/account, and a capability snapshot.
- `ModelDescriptor` answers whether a model is valid for that exact intersection.
- A platform fallback can make `matrix_included` ready; it never makes `owner_anthropic` connected.
- `matrix_included` is ready only when explicit current policy eligibility and fresh bounded relay health are both ready.
- Chat persistence stores stable IDs and remains readable if a catalog entry becomes legacy or unavailable.
- Logout, account removal, and harness disable are separate server-confirmed transitions and never delete Chat history.

### Security architecture

The full route auth matrix is in [contracts/http.md](./contracts/http.md), and relay header/body rules are in [contracts/relay.md](./contracts/relay.md).

- Owner gateway routes use the existing authenticated owner/session boundary and origin/CSRF posture. Provider callbacks additionally bind one-time state to that owner.
- Relay routes accept only a runtime-scoped credential with exact audience and `ai:invoke` scope. Identity is derived at the relay; browser headers are ignored.
- Mutations use `bodyLimit`, discriminated Zod schemas, revision/one-time conditional writes, atomic secret files, and generic error mapping.
- Fixed provider URLs eliminate user-controlled SSRF. Redirects remain rejected, and DNS-rebinding risk is absent unless a future user-configurable base URL is separately specified.
- Cloudflare receives request content to serve the inference call, but `cf-aig-collect-log-payload: false` prevents gateway payload retention. The product explains this third-party data flow.

### Integration wiring and startup

Owner gateway startup:

1. Construct `ProviderCredentialStore(homePath)`; validate its owner-root path and secret-file policy.
2. Construct provider adapters with fixed endpoints and injected fetch/clock/logger.
3. Construct `ProviderHealthService` with capped TTL/LRU cache and provider adapters.
4. Construct `ConnectionAttemptRegistry` with max global/per-owner counts, expiry sweep, and shutdown drain.
5. Construct `AiProviderService` from funded-policy projection, credential store, health service, driver registry, and model catalog.
6. Resolve every dependency at route registration; register provider routes and inject the same service into Settings and canonical Chat catalog.
7. On shutdown, stop connection admission, clear attempt secrets/timers, clear health cache/timers, then close only resources created by the gateway.

Central relay startup:

1. Parse/validate environment before listening: Cloudflare gateway URL/credential, funded flag, model allowlist, budgets, rate/concurrency/body/timeout caps, runtime-signing keys, telemetry configuration.
2. Construct `RuntimeCredentialVerifier`, `FundedPolicySource`, capped limiters, Cloudflare client, safe error mapper, and telemetry.
3. Register only the allowlisted Anthropic endpoints; dependency absence fails startup.
4. Start policy/key refresh and stale-limiter cleanup timers with bounded intervals.
5. On shutdown, stop admission, abort/drain streams within a deadline, clear timers/maps, flush bounded telemetry, and destroy only owned Postgres/Kysely resources when the later authorizer is enabled.

Platform provisioning:

1. Create/resolve the runtime identity at provisioning.
2. Issue/derive a scoped relay credential and inject relay base URL + token into the VPS host service environment.
3. Never inject the central Cloudflare/Anthropic funded credential.
4. Rotation/revocation updates the platform verifier and runtime service without rewriting owner provider state.

## Delivery Plan

Every numbered slice is an independently reviewable PR. Tests are written red first. Do not combine later commercial metering or ACP harnesses into the funded preview PR.

### Phase 0 — Runtime spikes and contract freeze

**Goal**: remove uncertainty before dependency, model, or auth commitments.

1. Add real-SDK spike tests for `@anthropic-ai/claude-agent-sdk@0.3.251` covering first-turn in-process MCP tools, `query()` + `resume`, PreToolUse controls, the `skills` option, Task/subagents, cancellation, structured refusals/usage, relay base URL/token, and owner Anthropic profile auth.
2. Spike official Anthropic login status/flow. Prefer a supported machine-readable profile/status integration; otherwise freeze visible terminal launch + polling.
3. Spike OpenRouter Agent SDK compatibility and OAuth PKCE exchange.
4. Verify Cloudflare Anthropic streaming, required SDK/beta headers, payload-log disable header, custom metadata, and global spend controls.
5. Record deviations in SDK verification docs; stop if first-turn tools, resume, or auth cannot be reliable.

**Checkpoint**: red/green fake-provider assertions plus bounded real low-cost tests; `bun run test` and kernel coverage; local Docker compatibility only if exercising proxy packaging; no rollout.

**Verification record**: [`sdk-verification.md`](./sdk-verification.md) captures the exact SDK/runtime results, reproducible commands, and the credential-blocked live checks that remain before rollout.

**PR**: `test(kernel): verify current agent sdk and gateway behavior`

### Phase 1 — Upgrade Agent SDK and current model catalog

**Goal**: modernize the kernel without changing funding behavior.

1. Update the SDK and root lockfile with `pnpm install` at repo root.
2. Keep V1 `query()`/`resume`; migrate deprecated skill/task options and adopt only spike-proven behavior.
3. Add bounded descriptors for Sonnet 5, Opus 5, Fable 5, and Haiku 4.5; expose only transport-tested models.
4. Make effort/thinking/sampling controls model-capability-driven, especially Sonnet 5.
5. Normalize structured refusals, canonical model/provider, rate limits, and usage into Chat events.
6. Classify old IDs as legacy without rewriting persisted Chats.

**Checkpoint**: tests first for option assembly, resume, refusals, usage, and legacy selection; real SDK suite on enabled models; test/typecheck/coverage/pattern gates; local Docker compatibility and release-parity VPS direct-owner-auth smoke.

**PR**: `feat(kernel): update agent sdk and anthropic models`

### Phase 2 — Canonical provider/account truth

**Goal**: make Chat and Settings truthful before funded access.

1. Add V3 contracts separating access sources, accounts, drivers, instances, readiness, and models.
2. Extract `packages/gateway/src/ai-providers/` with `DOMAIN.md`, credential adapters, bounded health service, and catalog service.
3. Adapt `system/config.json`, provider profiles, coding-agent registry, and platform fallback. File presence is `unverified`, not `ready`.
4. Return an explicit access source from `kernel-credentials.ts`; never silently change funding for an explicit selection.
5. Make provider catalog, Settings, Chat picker, onboarding, and shells consume the same snapshot.
6. Preserve drafts/projects through setup using serializable state and stable selectors.
7. Keep compatibility routes as service adapters during migration.

**Checkpoint**: status matrix fixtures; Chat/Settings parity; timeout-vs-invalid and error allowlist tests; test/typecheck/coverage/React Doctor/pattern gates; local multi-shell compatibility and Canvas-first disposable-VPS verification.

**PR**: `feat(chat): unify provider account and model state`

### Phase 2B — Shared Agents & providers foundation

**Goal**: converge Canvas, Web Desktop, and Electron on the approved Settings
information architecture before adding account mutations.

1. Add shared bounded derivations and action contracts over V3; do not create a
   renderer-owned provider store.
2. Add the **Agents & providers** surface with a **Harness instances** rail,
   harness health, selected account/access source, model provider, model route,
   and truthful read-only usage authority.
3. Move Matrix identity and `soul.md` concerns to **Identity & personality**;
   reserve **Custom agents** for a future `~/agents/custom/` surface.
4. Reuse the feature implementation in Canvas and Web Desktop. Adapt Electron
   to the same schemas, derivations, action semantics, and layout; its window
   chrome and Terminal launcher may remain native.
5. Define but do not enable mutation controls whose server authority has not
   shipped. Missing install, signed-out, stale, unavailable, offline, and
   read-only states must be explicit.
6. Capture Canvas, Web Desktop, and Electron evidence from the same fixture.

**Checkpoint**: V3 fixture/component tests prove identical state and available
actions across all three surfaces; Canvas is validated first, then Web Desktop,
then Electron; no UI claims multi-account mutation, funded credit, or add-ons
before those authorities exist.

**PR**: `feat(settings): add shared agents and providers foundation`

### Phase 3 — Matrix-funded relay preview

**Goal**: enable first Chat without BYOK, with no per-user balance UI yet.

1. Split `packages/proxy` into composition, auth, funded policy, bounded limits, Cloudflare client, stream relay, safe errors, and telemetry; add `DOMAIN.md`.
2. Remove/disable raw upstream-key pass-through and SQLite quota handling for funded routes. Add no replacement persistence yet.
3. Accept only scoped/revocable runtime credentials; derive owner/runtime identity centrally.
4. Forward only allowlisted models/fields/headers to fixed Cloudflare Anthropic endpoints. Disable payload logging and reject redirects.
5. Enforce feature flag, cohort, Cloudflare spend fuse, global/per-runtime rates and concurrency, size/output/tool limits, timeouts, stream bounds, cancellation, and shutdown drain.
6. Provision relay URL/runtime token to VPSes, never the central upstream secret.
7. Advertise `matrix_included` only when an explicit current policy authorizes
   the owner/runtime for at least one allowed model and a fresh bounded relay
   health result says the route is usable. Fail closed if either source is
   missing, stale, disabled, or unavailable.
8. Add bounded-cardinality, content-free metrics and alerts.

**Checkpoint**: runtime-auth rejection suite; owner gateway -> relay -> fake Cloudflare SSE integration including abort/failure; rate/concurrency/eviction and leakage tests; test/typecheck/coverage/pattern/production-shell gates. A local Docker scenario may test packaged proxy compatibility, but release verification uses an exact bundle on a disposable VPS.

**Rollout**: disabled dev -> staff/disposable allowlist -> small canary with low spend fuse -> 24-hour and 7-day reviews -> gradual widening. Kill switch disables funded requests within 60 seconds while owner paths remain available.

**PR**: `feat(proxy): add matrix-funded ai relay`

### Phase 4 — Smooth Anthropic and OpenRouter connection

**Goal**: owner-funded continuity from Chat or Settings.

1. Add bounded `ConnectionAttemptRegistry` and authenticated routes.
2. Implement OpenRouter OAuth PKCE with one-time owner-bound state, fixed callback, bounded exchange/probe, atomic credential write, and idempotent callbacks.
3. Implement the spike-proven Anthropic flow: supported in-app authorization/polling if available, otherwise visible canonical `__terminal__` login plus health polling and automatic draft return.
4. Keep API-key entry; save only after successful probe and distinguish timeout from rejection.
5. Add multiple owner-scoped accounts without overwriting existing profiles;
   every runnable harness instance names its selected account/access source.
6. Add connect/reconnect/logout/remove/retry/stale and account/funding labels
   through V3. Logout retains the account entry where supported; removal deletes
   the credential/profile after active-Chat reassignment or confirmation;
   disabling a harness remains a separate operation that preserves accounts and
   readable Chats.
7. Add owner OpenRouter transport/models only when spike-proven; owner keys never pass through funded relay.

**Checkpoint**: replay/wrong-owner/expiry/denial/duplicate/timeout/malformed-response/failed-write/logout/remove/disable/reassignment/draft tests; fake-provider OAuth E2E and reviewed manual real-account test; test/typecheck/coverage/React Doctor/pattern/build gates; Canvas-first, then Web Desktop and Electron disposable-VPS login validation.

**PR**: `feat(chat): add anthropic and openrouter account connections`

### Phase 5 — Allowances, metering, and add-ons

**Goal**: add pricing after activation and operations are proven.

1. Specify product entitlements/add-on/refund behavior; do not infer org sharing.
2. Add Kysely migrations for entitlements, atomic reservations, content-free usage, and reconciliation.
3. Reserve before dispatch in one transaction with budget predicate in the write and unique request ID.
4. Reconcile canonical model/tokens/cost; bounded job releases/reconciles abandoned holds.
5. Add allowance/add-on UI, warnings, stops, exports, deletion/retention, and support tools. Exact remaining credit comes only from the authoritative Matrix ledger; provider subscription allowance and provider API balance remain separately labeled sources. Add-on Checkout accepts only a bounded server-owned package ID and request UUID; Clerk auth plus the active machine row derive owner/machine/runtime, and a signed webhook verifies exact paid USD totals before atomically recording its receipt and idempotent ledger grant.
6. Retain Cloudflare limits as a second, eventually consistent fuse.
7. Do not model variable user add-ons as Cloudflare rules: a split-by-user rule gives each value the same budget, Cloudflare caps gateways at 20 spend rules, and concurrent requests can briefly overshoot.

**Checkpoint**: parallel race, idempotency, crash, job ownership/shutdown, refund/rollover, and no-content tests; fake usage + billing sandbox integration; migration/test/typecheck/coverage/pattern gates; staging disposable-VPS verification.

**PRs**: split accounting, billing/add-on, and shell UI.

### Phase 6 — Broader models and harnesses

**Goal**: expand through the canonical contract only.

1. Add a Matrix-published signed/validated catalog with bundled and last-known-good fallback, borrowing the useful `t3code` lifecycle.
2. Add Baseten as an optional OpenAI-compatible source after transport, data policy, quality, and cost evaluation.
3. Reuse Matrix OpenCode and converge generic harness routing for Hermes,
   OpenClaw, Pi, and OpenCode. Generic harnesses may select a compatible model
   provider and model; model-specific Claude/Codex routes expose only proven
   overrides.
4. Build one generic bounded ACP driver with process/env isolation, probes, cancellation, resume semantics, caps, and shutdown ownership.
5. Add Cursor or Grok only as thin, separate adapters after ACP passes; do not copy the comparison registry wholesale.
6. Add current Codex model IDs only after Matrix's harness reports and validates them.

**Checkpoint**: catalog signature/bounds/fallback, transport conformance, capability-lie, child secret isolation, output cap, timeout/cancel/cleanup tests; standard gates and disposable-VPS Canvas run/resume/cancel.

## Test Strategy

- **Unit/contract**: Zod boundaries, header allowlists, model intersection, source precedence, statuses, safe errors, usage normalization, limiter eviction, callback state, and redaction. Shared provider/model derivation is pure and reused by service/store/UI tests.
- **Integration**: real Agent SDK; authenticated Hono routes/body limits; streaming relay/backpressure/disconnect/timeout/malformed data/shutdown; provisioning secret isolation; Chat/Settings parity; logout/remove/disable and active-Chat reassignment.
- **Renderer parity**: one V3 fixture and shared action harness run through Canvas, Web Desktop, and Electron. Component/contract tests compare state and available actions; manual evidence follows Canvas -> Web Desktop -> Electron.
- **Security/failure**: exercise every auth row; no wildcard CORS/untrusted identity/arbitrary URL/redirect; timing-safe comparisons; every fetch/buffer/map/timer bounded; safe error mapping; canary leakage scan; atomic writes and later transaction predicates.

Applicable implementation PR gates:

```bash
bun run test
bun run test:coverage
bun run typecheck
bun run check:patterns:diff
bun run build:shell:production
npx react-doctor@latest shell
```

Use targeted tests during red/green iteration, then repository gates. Real model tests use the lowest-cost model that proves the behavior where possible.

## Rollout, Operations, and Rollback

- Flags: funded relay, cohort, each funded model, provider connections, remote catalog, later metering.
- Metrics: admissions/rejections, concurrency, TTFT overhead, latency, upstream class, canonical model, bounded usage/cost, auth source, login outcomes, and catalog version. Hash/limit identifiers.
- Alerts: Cloudflare balance/spend, request/auth/error spikes, latency, limiter saturation, callback failures, catalog rejection, and later reconciliation lag.
- Rollback: disable funded admission, retain owner paths, revoke relay credentials, pin bundled catalog, and deploy the previous exact host bundle through platform. Never overwrite owner Chat/provider files.

## Graphite Delivery Order

Do not flatten these review boundaries. Restack each layer on the accepted head
of the prior layer and publish only after its tests and invariants are complete:

1. `feat(gateway): add canonical ai provider snapshot`
2. `feat(chat): unify provider account and model state`
3. `feat(settings): add shared agents and providers foundation`
4. `feat(chat): add multi-account provider authentication`
5. `feat(proxy): activate policy-gated matrix-funded ai`
6. accounting, billing/add-on, and truthful credit UI as separate PRs
7. catalog/model-provider additions and each new harness adapter as separate PRs

Layers 1-2 establish read-only truth. Layer 3 establishes renderer parity but
must leave unimplemented mutations disabled or labeled. Layer 4 owns account
lifecycle. Layer 5 may advertise Matrix AI as ready only after policy and relay
health are wired. Exact per-user remaining credit waits for layer 6.

The first layer-6 increment exposes the platform Postgres metering summary to
the exact authenticated runtime and projects it into provider settings. The
Matrix card distinguishes promotional and add-on balances, held reservations,
settled monthly use, remaining monthly budget, and the smaller amount currently
spendable. Stripe purchase is advertised only when the real checkout and ledger
grant workflow is authoritatively configured. `topUpEnabled` comes from the
platform funding summary (never owner-local JSON), and `add_credit` appears only
with it. The shared Canvas/Web Desktop/Electron package picker sends
`$5/$10/$25` package IDs to one Clerk-authenticated platform route. Hosted
Stripe Checkout owns card collection; the signed completion webhook verifies
kind, mode, status, payment status, currency, exact amount, Price, request,
owner, machine, and runtime. Webhook receipt and non-expiring add-on grant
commit in one transaction and use `ON CONFLICT` idempotency. Cloudflare remains
upstream; Matrix's ledger owns the credit. Add-on Stripe Tax remains disabled
until operators explicitly attest that required registrations are active.

## Documentation and Review Deliverables

Every implementation PR uses a Conventional Commit title, states source of truth/lock or transaction scope/acceptable orphan states/auth source/deferred scope, passes applicable gates, and reaches Greptile 5/5.

Before general availability, open a separate `FinnaAI/matrix-os-site` PR under `content/docs/` covering harness/model-provider/account/access-source terminology, Matrix AI funding versus provider login, models, login/logout/removal/disable behavior, data flow/logging, fair-use controls, safe troubleshooting, and later allowances/add-ons. Keep the public page aligned with shipped layers only.

## Complexity Tracking

No constitution violation is requested. A central relay is necessary because a shared upstream credential cannot safely reside on owner VPSes, while vendor gateways cannot authoritatively enforce Matrix identity, entitlement, or later atomic balances. The provider-domain extraction is justified because the feature spans contracts, gateway, kernel, relay, platform, shell, auth, recovery, and multiple sources of truth.

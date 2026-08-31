# Tasks: Phase 2 — Canonical Truth and Provider Settings Foundation

**Input**: Design documents from `specs/118-ai-gateway-provider-auth/`
**Scope**: The checked tasks record Delivery Plan Phase 2 only. The unchecked
successor tasks record the shared Settings/parity foundation and later Graphite
boundaries. Runtime spikes, funded relay transport, and the Agent SDK/model
upgrade are prerequisites. Provider login mutations, funded relay activation,
metering/add-ons, and broader harnesses remain deferred until their own layers.
**Tests**: Required by the Matrix OS constitution; every behavior task starts with a failing focused test.

## Phase 1: Setup and Baseline

**Purpose**: Bind this worktree to spec 118 and establish the current behavior before changing public contracts.

- [X] T001 Record the Phase 2 scope, merged prerequisites, and Graphite split in `specs/118-ai-gateway-provider-auth/tasks.md`
- [X] T002 Verify existing ignore rules cover Node, build, coverage, environment, Docker, editor, and temporary artifacts in `.gitignore`, `.dockerignore`, `eslint.config.mjs`, and `.prettierignore`
- [X] T003 Run the focused provider/settings baseline suites in `tests/contracts/`, `tests/gateway/agent-config-service.test.ts`, `tests/gateway/chat-provider-catalog.test.ts`, and `tests/shell/agent-config.test.ts`

---

## Phase 2: Foundational Canonical Contracts

**Purpose**: Define the bounded V3 provider/account/access-source projection shared by every shell.

**⚠️ CRITICAL**: The gateway service and UI adapters depend on this contract.

- [X] T004 [P] Add failing schema tests for access sources, accounts, drivers, instances, models, active selection, deterministic caps, and secret/error rejection in `tests/contracts/ai-provider.test.ts`
- [X] T005 [P] Add failing compatibility tests for the `kernel` provider driver kind in `tests/contracts/canonical-chat-provider.test.ts`
- [X] T006 Implement `AiProviderSnapshotV3Schema` and its bounded view schemas in `packages/contracts/src/ai-provider.ts`
- [X] T007 Extend the canonical driver vocabulary with `kernel` and export the V3 provider types from `packages/contracts/src/canonical-chat-primitives.ts` and `packages/contracts/src/index.ts`
- [X] T008 Run the contract tests and mark the canonical contract checkpoint green

**Checkpoint**: A strict, secret-free V3 snapshot can represent Matrix-funded readiness independently from owner Anthropic/OpenRouter account state.

---

## Phase 3: User Story 3 — Truthful Gateway Provider State (Priority: P1) 🎯 MVP

**Goal**: Produce one gateway-owned snapshot in which Matrix AI can be ready while owner Anthropic and OpenRouter remain explicitly not connected.

**Independent Test**: With platform-funded access available and no owner credential, `GET /api/ai/providers` reports `matrix_included` ready, both owner accounts setup-required, the kernel driver installed/ready, and only eligible models on the Matrix-funded instance.

### Tests for User Story 3

- [X] T009 [P] [US3] Add failing credential-source tests for explicit Matrix, owner API-key, owner profile, missing, malformed, and unreadable states in `tests/gateway/kernel-credentials.test.ts`
- [X] T010 [P] [US3] Add failing service fixtures for Matrix-included, owner-key, owner-profile-unverified, disabled, stale, legacy-model, and unavailable intersections in `tests/gateway/ai-provider-service.test.ts`
- [X] T011 [P] [US3] Add failing route tests for authenticated canonical reads, refresh behavior, bounded responses, and safe failures in `tests/gateway/ai-provider-routes.test.ts`
- [X] T012 [P] [US3] Add failing legacy settings-adapter assertions proving platform fallback never marks the owner Anthropic account connected in `tests/gateway/agent-config-service.test.ts` and `tests/gateway/settings-agent-summary.test.ts`

### Implementation for User Story 3

- [X] T013 [US3] Expose an explicit, secret-free kernel credential/access-source resolution from `packages/gateway/src/kernel-credentials.ts`
- [X] T014 [US3] Implement bundled bounded model policy and capability intersection in `packages/gateway/src/ai-providers/model-catalog.ts`
- [X] T015 [US3] Implement owner credential/account projections without treating file presence as verified readiness in `packages/gateway/src/ai-providers/credential-store.ts`
- [X] T016 [US3] Implement a capped TTL/LRU readiness cache with recurring cleanup and shutdown drain in `packages/gateway/src/ai-providers/health.ts`
- [X] T017 [US3] Implement deterministic `AiProviderService` snapshot composition and refresh in `packages/gateway/src/ai-providers/service.ts`
- [X] T018 [US3] Register the authenticated read-only provider endpoint and validate dependencies at registration in `packages/gateway/src/ai-providers/routes.ts` and `packages/gateway/src/server.ts`
- [X] T019 [US3] Adapt `GET /api/settings/agent` from the canonical snapshot while preserving the V2 compatibility response in `packages/gateway/src/agent-config/service.ts` and `packages/gateway/src/routes/settings.ts`
- [X] T020 [US3] Document the gateway domain source of truth, cache ownership, shutdown, auth, and deferred mutations in `packages/gateway/src/ai-providers/DOMAIN.md`
- [X] T021 [US3] Run gateway/contract tests and the gateway TypeScript project check for the service checkpoint

**Checkpoint**: The gateway has one canonical provider/account truth and the legacy Settings route is only an adapter.

---

## Phase 4: User Story 3 — Chat and Settings Parity (Priority: P1)

**Goal**: Make Chat and Settings consume the same access-source, account, harness, and model snapshot without silently switching funding.

**Independent Test**: The decisive fixture renders Matrix AI as ready/included, Anthropic and OpenRouter as not connected, the Agent SDK kernel as ready, and Claude Sonnet 5 as selectable only through the Matrix-funded instance in both Chat and Settings.

### Tests for User Story 3

- [X] T022 [P] [US3] Add failing canonical Chat catalog tests for the kernel Matrix-funded and owner-funded instances in `tests/gateway/chat-provider-catalog.test.ts`
- [X] T023 [P] [US3] Add failing bounded client normalization and safe-error tests for `/api/ai/providers` in `tests/shell/ai-provider-client.test.ts`
- [X] T024 [P] [US3] Add failing Settings rendering tests for separate funding, account, harness, readiness, and model labels in `tests/shell/agent-runtime-panel-provider-state.test.tsx`
- [X] T025 [P] [US3] Add failing Chat setup/model-picker tests proving unavailable models cannot be selected and drafts remain local in `tests/shell/chat-app-provider-state.test.tsx`

### Implementation for User Story 3

- [X] T026 [US3] Inject the canonical provider snapshot into Chat catalog generation and add the `kernel` instances in `packages/gateway/src/chat/provider-catalog.ts` and `packages/gateway/src/chat/provider-routes.ts`
- [X] T027 [US3] Implement the bounded shell provider client and serializable stable derivation helpers in `shell/src/lib/ai-providers.ts`
- [X] T028 [US3] Render truthful access-source and owner-account cards from the canonical snapshot in `shell/src/components/settings/sections/AgentRuntimePanel.tsx`
- [X] T029 [US3] Replace the hard-coded Chat model list with the canonical ready-instance/model projection while preserving the active draft in `shell/src/components/ChatApp.tsx` and `shell/src/components/chat-app-hermes.ts`
- [X] T030 [US3] Verify the existing desktop canonical Chat catalog accepts and labels gateway-projected `kernel` instances in `desktop/src/renderer/src/features/chat/ProviderModelPicker.tsx` and `tests/desktop/chat-provider-catalog-client.test.ts`
- [X] T031 [US3] Run Chat/Settings parity tests, React Doctor on changed shell files, and the shell production build

**Checkpoint**: Chat and Settings display identical provider truth; existing chats remain readable and unavailable selections cannot be submitted.

---

## Phase 5: Polish and Review Gates

**Purpose**: Validate failure modes, keep the PR layers reviewable, and freeze the phase for review.

- [X] T032 [P] Run `bun run typecheck` and `bun run check:patterns:diff` from the repository root
- [X] T033 [P] Run `bun run test` and record any unrelated platform-specific baseline failures in the PR body
- [X] T034 Run the spec quickstart provider-snapshot fixture and verify client/log output contains no secrets, raw provider errors, or filesystem paths
- [X] T035 Mark every completed task `[X]` in `specs/118-ai-gateway-provider-auth/tasks.md` and update Phase 2 implementation notes in `specs/118-ai-gateway-provider-auth/quickstart.md`
- [ ] T036 Publish the Graphite stack, resolve review feedback to Greptile 5/5, add `ready-for-ci`, and monitor label-triggered CI to green

---

## Phase 6: Shared Settings and Parity Foundation (Next Graphite Layer)

**Purpose**: Establish the complete read-only **Agents & providers** design and
cross-shell contract without pretending that account mutations, funded credit,
or add-ons already exist.

- [ ] T037 Add failing shared derivation/component tests for the approved harness, model-provider, account, and access-source terminology
- [ ] T038 Add failing parity fixtures proving Canvas, Web Desktop, and Electron show identical V3 state and available actions
- [ ] T039 Build the shared Harness instances rail and configuration/models surface over V3; keep legacy Settings code as an adapter during migration
- [ ] T040 Add **Identity & personality** for Matrix identity and `soul.md`; reserve **Custom agents** for future `~/agents/custom/` definitions
- [ ] T041 Add explicit missing-install, signed-out, stale, unavailable, offline, and read-only states; do not enable serverless mutation controls
- [ ] T042 Add shell adapters for visible canonical Terminal launch while keeping authentication orchestration shared
- [ ] T043 Capture current Canvas, Web Desktop, and Electron visual evidence from one fixture and run shared parity/build/React Doctor gates

**Checkpoint**: all three desktop shells expose the same read-only operational
truth, use shared feature code where possible, and do not claim multi-account
mutation or funded balances.

---

## Successor Graphite Layers (Deferred)

- [ ] T044 Add multi-account connection attempts and server-confirmed login, logout, removal, disable, and active-Chat reassignment flows with auth/body-limit/idempotency/failure tests
- [ ] T045 Activate Matrix-funded access only when explicit owner/runtime policy and fresh relay health are both ready; add scoped runtime identity and leakage/failure tests
- [ ] T046 Add Matrix Postgres/Kysely entitlements, atomic spend reservations, reconciliation, add-ons, and truthful credit UI; retain Cloudflare limits as a coarse fuse
- [ ] T047 Add generic/model-specific harness routing and additional model providers through V3 conformance tests, one adapter PR at a time
- [X] T047A Register Pi and OpenCode on customer VPS gateways and bind each read-only structured run to its exact portable access source
- [X] T047B Add canonical OpenCode JSON execution/resume plus fail-closed credential, sandbox, timeout, and catalog conformance tests
- [ ] T047C Add an enforceable workspace-write sandbox and approval transport before Pi or OpenCode advertises broader permission modes

### T046 add-on checkout increment

- [X] T046A Add server-owned `$5/$10/$25` Stripe Price configuration and a strict Clerk-authenticated Checkout route that derives the active owner machine/runtime
- [X] T046B Add signed completion validation plus one-transaction, `ON CONFLICT`-idempotent webhook receipt and Matrix add-on ledger grant
- [X] T046C Gate `topUpEnabled` and `add_credit` only from authoritative platform checkout configuration, failing closed when absent
- [X] T046D Add one shared package/busy/safe-error UI with same-origin web navigation and authenticated Electron external-browser handoff
- [X] T046E Cover package spoofing, unpaid/expired/mismatched events, duplicate delivery, transaction rollback, shell parity, redirect validation, and Stripe integration metadata
- [X] T046F Persist immutable Checkout claims, reuse active attempts, enforce a durable five-per-hour owner/runtime creation limit, and fulfill paid asynchronous methods against the claim after configuration rotation
- [X] T046G Reverse refunded/disputed grants idempotently, convert consumed credit to frozen debt, restore won disputes, and cover tax-on-top subtotal validation

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts from merged `main` at `53cd01a66fb338df330ef89bede0190a82723e3a`.
- **Foundational contracts (Phase 2)**: Depends on Setup and blocks all provider projection work.
- **Gateway truth (Phase 3)**: Depends on the V3 schemas and is independently testable through `GET /api/ai/providers`.
- **Chat/Settings parity (Phase 4)**: Depends on the gateway truth and remains independently reviewable as an upstack PR.
- **Polish (Phase 5)**: Depends on both Graphite layers.
- **Shared Settings (Phase 6)**: Depends on the complete V3/Chat stack and must land before account-lifecycle UI.
- **Account lifecycle (T044)**: Depends on shared Settings plus authenticated owner-bound mutation contracts.
- **Funded activation (T045)**: Depends on explicit policy and relay-health authorities; the read-only V3 fallback is insufficient.
- **Metering/add-ons (T046)**: Depends on active funded routing and the Matrix-owned atomic ledger, not Cloudflare per-user rules.
- **Harness expansion (T047)**: Depends on V3 conformance and must not introduce renderer-specific state.

### User Story Dependencies

- **User Story 3** is the sole Phase 2 product story and can be validated at both the gateway and renderer checkpoints.
- User Story 1 funded activation depends on this phase but remains Phase 3 of the delivery plan.
- User Story 2 provider login mutations remain Phase 4 of the delivery plan.

### Parallel Opportunities

- T004 and T005 can be authored independently before T006/T007.
- T009–T012 cover different boundaries and can be authored independently before service implementation.
- T022–T025 cover gateway, client, Settings, and Chat surfaces in separate files.
- T032 and T033 may run concurrently after implementation freezes.

---

## Graphite Stack Plan

- **Stack 1/2 — `feat(gateway): add canonical ai provider snapshot`**: T001–T021. Contracts, explicit credential source, bounded gateway service, authenticated read route, and V2 Settings compatibility adapter.
- **Stack 2/2 — `feat(chat): unify provider account and model state`**: T022–T036. Canonical kernel instances, Chat/Settings parity, shell client/UI, validation, and monitoring.

Each layer stays below the Matrix OS review limits, carries the backend invariants section, reaches Greptile 5/5 on its exact head, and runs label-gated CI. The layers are not flattened.

### Successor stack

- **Stack 3 — `feat(settings): add shared agents and providers foundation`**: T037–T043. Read-only V3 UI, information architecture, and Canvas/Web Desktop/Electron parity.
- **Stack 4 — `feat(chat): add multi-account provider authentication`**: T044 account lifecycle only.
- **Stack 5 — `feat(proxy): activate policy-gated matrix-funded ai`**: T045 relay activation only.
- **Stack 6 — accounting/billing/credit UI**: T046 split into migrations/reservations, billing/add-ons, then UI.
- **Stack 7+ — catalog/model providers/harnesses**: T047, one bounded adapter or catalog concern per layer.

The successor stack must preserve review boundaries and must not show exact
remaining credit until Stack 6's ledger is authoritative.

---

## Implementation Strategy

1. Land the strict V3 contract before service behavior.
2. Make the decisive Matrix-included/owner-disconnected fixture green at the gateway.
3. Treat existing V2 settings and Chat catalog shapes as compatibility projections only.
4. Move renderers to the V3 snapshot without changing provider-login mutations or funded relay activation.
5. Freeze and review each Graphite layer independently.

## Deferred Scope

- Anthropic/OpenRouter connect, probe, save, callback, and disconnect mutations.
- Production funded relay credentials, eligibility/cohort refresh, and VPS provisioning.
- Per-user allowances, usage persistence, metering, purchases, refunds, and add-ons.
- Remote signed catalogs, Baseten, generic ACP, Cursor, and Grok.
- Public docs publication and production rollout, which remain required before general availability.
- Exact credit/remaining values before the Matrix ledger and reconciliation ship.

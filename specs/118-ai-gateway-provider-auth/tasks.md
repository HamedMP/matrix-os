# Tasks: Phase 2 — Canonical Provider and Account Truth

**Input**: Design documents from `specs/118-ai-gateway-provider-auth/`
**Scope**: Delivery Plan Phase 2 only. Runtime spikes, funded relay transport, and the Agent SDK/model upgrade are already merged. Provider login mutations, funded relay activation, metering/add-ons, and broader harnesses remain deferred.
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

- [ ] T022 [P] [US3] Add failing canonical Chat catalog tests for the kernel Matrix-funded and owner-funded instances in `tests/gateway/chat-provider-catalog.test.ts`
- [ ] T023 [P] [US3] Add failing bounded client normalization and safe-error tests for `/api/ai/providers` in `tests/shell/ai-provider-client.test.ts`
- [ ] T024 [P] [US3] Add failing Settings rendering tests for separate funding, account, harness, readiness, and model labels in `tests/shell/agent-runtime-panel.test.tsx`
- [ ] T025 [P] [US3] Add failing Chat setup/model-picker tests proving unavailable models cannot be selected and drafts remain local in `tests/shell/chat-app-provider-state.test.tsx`

### Implementation for User Story 3

- [ ] T026 [US3] Inject the canonical provider snapshot into Chat catalog generation and add the `kernel` instances in `packages/gateway/src/chat/provider-catalog.ts` and `packages/gateway/src/chat/provider-routes.ts`
- [ ] T027 [US3] Implement the bounded shell provider client and serializable stable derivation helpers in `shell/src/lib/ai-providers.ts`
- [ ] T028 [US3] Render truthful access-source and owner-account cards from the canonical snapshot in `shell/src/components/settings/sections/AgentRuntimePanel.tsx`
- [ ] T029 [US3] Replace the hard-coded Chat model list with the canonical ready-instance/model projection while preserving the active draft in `shell/src/components/ChatApp.tsx` and `shell/src/components/chat-app-hermes.ts`
- [ ] T030 [US3] Reuse the canonical provider client for desktop Chat catalog normalization in `desktop/src/renderer/src/features/chat/chat-provider-catalog.ts`
- [ ] T031 [US3] Run Chat/Settings parity tests, React Doctor on changed shell files, and the shell production build

**Checkpoint**: Chat and Settings display identical provider truth; existing chats remain readable and unavailable selections cannot be submitted.

---

## Phase 5: Polish and Review Gates

**Purpose**: Validate failure modes, keep the PR layers reviewable, and freeze the phase for review.

- [ ] T032 [P] Run `bun run typecheck` and `bun run check:patterns:diff` from the repository root
- [ ] T033 [P] Run `bun run test` and record any unrelated platform-specific baseline failures in the PR body
- [ ] T034 Run the spec quickstart provider-snapshot fixture and verify client/log output contains no secrets, raw provider errors, or filesystem paths
- [ ] T035 Mark every completed task `[X]` in `specs/118-ai-gateway-provider-auth/tasks.md` and update Phase 2 implementation notes in `specs/118-ai-gateway-provider-auth/quickstart.md`
- [ ] T036 Publish the Graphite stack, resolve review feedback to Greptile 5/5, add `ready-for-ci`, and monitor label-triggered CI to green

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts from merged `main` at `53cd01a66fb338df330ef89bede0190a82723e3a`.
- **Foundational contracts (Phase 2)**: Depends on Setup and blocks all provider projection work.
- **Gateway truth (Phase 3)**: Depends on the V3 schemas and is independently testable through `GET /api/ai/providers`.
- **Chat/Settings parity (Phase 4)**: Depends on the gateway truth and remains independently reviewable as an upstack PR.
- **Polish (Phase 5)**: Depends on both Graphite layers.

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

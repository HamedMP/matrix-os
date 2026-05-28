# Tasks: Elixir Symphony Runtime

**Input**: Design documents from `/specs/083-elixir-symphony/`  
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/gateway-symphony-api.md`

**Tests**: Required. This feature touches host services, auth boundaries, external credentials, filesystem paths, and UI state.

## Phase 1: Setup And Spec Stack

- [ ] T001 Update `.specify/feature.json` to point at `specs/083-elixir-symphony`.
- [ ] T002 Commit spec, plan, research, data model, contracts, quickstart, and tasks as the first stack layer.
- [ ] T003 [P] Record upstream Symphony Apache-2.0 license/notice handling in the chosen source location.
- [ ] T004 [P] Decide and document the adapted Elixir source location after checking host-bundle packaging constraints.

---

## Phase 2: Host Runtime Foundation

**Purpose**: Package and run the Elixir service before gateway/app replacement.

- [ ] T005 [P] Add failing systemd/host-bundle test for `distro/customer-vps/systemd/matrix-symphony.service` in `tests/deploy/customer-vps/symphony-systemd.test.ts`.
- [ ] T006 [P] Add failing host-bundle packaging test that asserts the adapted Elixir runtime and license/notice files are included.
- [ ] T007 Vendor or import adapted Elixir Symphony source into the chosen Matrix path without committed `deps/` or build artifacts.
- [ ] T008 Add Matrix runtime config defaults for `MATRIX_HOME`, loopback host/port, workspace root, and Codex command.
- [ ] T009 Implement `matrix-symphony.service` running as `matrix` with `MATRIX_HOME=/home/matrix/home`.
- [ ] T010 Update `scripts/build-host-bundle.sh` to include the service and runtime.
- [ ] T011 Run host-bundle/systemd focused tests and Elixir tests or document unavailable toolchain fallback.

---

## Phase 3: Gateway Proxy And Credential Bridge (US1, US2, US3)

**Goal**: Make `/api/symphony/*` the Matrix-authenticated proxy/control plane for Elixir state.

**Independent Test**: Fake loopback Elixir service plus gateway tests verify auth, validation, timeout, bodyLimit, normalized payloads, and credential setup states.

- [ ] T012 [P] Add failing gateway proxy tests for authorized state/detail/refresh requests in `tests/gateway/symphony-proxy.test.ts`.
- [ ] T013 [P] Add failing gateway tests for unauthorized requests not contacting upstream.
- [ ] T014 [P] Add failing gateway tests for timeout/offline/malformed upstream responses returning generic errors.
- [ ] T015 [P] Add failing validation tests for issue identifiers, run IDs, mutating body limits, and unsafe upstream paths.
- [ ] T016 Implement `packages/gateway/src/symphony/proxy-contracts.ts` with Zod schemas and browser-safe response types.
- [ ] T017 Implement `packages/gateway/src/symphony/proxy.ts` with allowlisted loopback route templates and `AbortSignal.timeout()`.
- [ ] T018 Replace `packages/gateway/src/symphony-routes.ts` export path with the proxy-backed route registration while preserving auth behavior.
- [ ] T019 Implement initial Matrix Linear credential bridge status and setup-required behavior without exposing tokens.
- [ ] T020 Ensure legacy TypeScript orchestrator/run-table paths are not used by normal `/api/symphony/*` requests when Elixir proxy mode is enabled.
- [ ] T021 Run focused gateway proxy tests plus `bun run check:patterns`.

---

## Phase 4: Matrix App Shell (US4)

**Goal**: Render Elixir-backed Codex lifecycle state clearly in the Matrix Symphony app.

**Independent Test**: Seed browser-safe payloads and verify desktop/mobile UI states and actions.

- [ ] T022 [P] Add failing app tests for queue/running/needs-attention/done groups in `tests/default-apps/symphony-app.test.tsx`.
- [ ] T023 [P] Add failing app tests for active issue details: session ID, thread/turn count, logs, workpad URL, workspace path, refresh, stop.
- [ ] T024 [P] Add failing mobile-width layout regression for long titles, session IDs, and paths.
- [ ] T025 Update `home/apps/symphony/src/App.tsx` and supporting modules to consume the normalized proxy contract.
- [ ] T026 Add loading, service unavailable, setup-required, and action-in-flight states.
- [ ] T027 Run focused app tests and `node scripts/build-default-apps.mjs home/apps/symphony`.

---

## Phase 5: Legacy Retirement, Docs, And Validation (US5)

**Goal**: Remove duplicate runner semantics and document the new Matrix/Elixir boundary.

- [ ] T028 [P] Add tests proving normal Symphony API usage does not mutate TypeScript runner state.
- [ ] T029 Remove, disable, or quarantine the TypeScript Symphony orchestrator/run table behind the new proxy path.
- [ ] T030 Update `www/content/docs/symphony.mdx` with Matrix-owned Linear setup, service behavior, workspace root, app-server state, troubleshooting, and migration notes.
- [ ] T031 Update any host-bundle/release docs that list customer VPS services.
- [ ] T032 Run `bun run typecheck`.
- [ ] T033 Run `bun run check:patterns`.
- [ ] T034 Run `bun run test` or the agreed split of focused suites if full tests exceed CI time.
- [ ] T035 Build a host bundle and verify `matrix-symphony.service`, release files, and runtime state paths.

---

## Dependencies & Execution Order

- Phase 1 blocks all other work.
- Phase 2 blocks gateway proxy rollout because the proxy needs a stable local service contract.
- Phase 3 blocks app replacement because the app should not call Elixir directly.
- Phase 4 can proceed against mocked contracts once Phase 3 schemas exist.
- Phase 5 is final cleanup after service/proxy/app paths pass focused validation.

## Graphite Stack Plan

- **Stack 1**: Spec, contracts, tasks, source-location/license decision, first failing packaging tests.
- **Stack 2**: Elixir runtime packaging and `matrix-symphony.service`.
- **Stack 3**: Gateway proxy and credential bridge.
- **Stack 4**: Matrix Symphony app shell over Elixir state.
- **Stack 5**: Legacy TypeScript runner retirement, docs, full validation.

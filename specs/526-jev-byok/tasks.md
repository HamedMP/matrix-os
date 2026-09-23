# Tasks: Jev email triage

**Input**: `spec.md`, `design.zh-en.md`, `plan.md`

**Tests**: Mandatory. Every implementation task starts from a failing Vitest or integration assertion.

## Phase 1: Shared contracts and policy (Stack B)

- [x] T001 [P] [US1] Add failing Jev request/result schema tests in `tests/contracts/jev.test.ts`
- [x] T002 [P] [US1] Add failing threshold, multi-label, Review and archive-gate tests in `tests/gateway/jev-email-triage-policy.test.ts`
- [x] T003 [US1] Implement bounded Jev schemas and seven stable answer IDs in `packages/contracts/src/jev.ts` and export them from `packages/contracts/src/index.ts`
- [x] T004 [US1] Implement immutable `email-triage-v1` questions in `packages/gateway/src/jev/email-triage-recipe.ts`
- [x] T005 [US1] Implement the pure deterministic triage policy in `packages/gateway/src/jev/email-triage-policy.ts`
- [x] T006 [US1] Run focused contract/policy tests and confirm full deterministic-policy branch coverage

## Phase 2: Funded evaluation path (Stack B)

- [x] T007 [P] [US1] Add failing bounded request and malformed-upstream tests in `tests/proxy/funded-relay-evaluation.test.ts`
- [x] T008 [P] [US1] Add failing auth, policy, credit, timeout, idempotency and settlement tests in `tests/proxy/funded-relay-evaluation.test.ts`
- [x] T009 [US1] Implement strict Jev upstream serialization in `packages/proxy/src/funded-relay-evaluation-request.ts`
- [x] T010 [US1] Implement bounded Jev response and usage/cost normalization in `packages/proxy/src/funded-relay-evaluation-response.ts`
- [x] T011 [US1] Reuse the validated Cloudflare account, gateway ID and Workers AI credential for fixed `typesafe/jev` evaluation in `packages/proxy/src/funded-relay-config.ts`
- [x] T012 [US1] Mount authenticated `POST /v1/evaluate` with admission, timeout, redirect rejection and settlement in `packages/proxy/src/funded-relay.ts`
- [x] T013 [US1] Run evaluation and existing funded-relay regression suites; inspect failure logs for secret/body leakage

## Phase 3: Owner-scoped local Gateway (Stack B)

- [x] T014 [P] [US1] Add failing route boundary/body-limit/safe-error tests in `tests/gateway/jev-routes.test.ts`
- [x] T015 [P] [US3] Add failing duplicate, changed-fingerprint and unknown-outcome tests in `tests/gateway/jev-service.test.ts`
- [x] T016 [US1] Implement recipe resolution and funded relay invocation in `packages/gateway/src/jev/service.ts`
- [x] T017 [US1] Implement authenticated `POST /api/jev/evaluate` in `packages/gateway/src/jev/routes.ts` and wire dependencies at registration
- [x] T018 [US3] Implement owner-scoped completed-request deduplication using the existing Postgres/Kysely accounting or invocation mechanism
- [x] T019 [US1] Add a controlled-upstream full-path test from local Gateway through the funded relay and verify one settlement

## Phase 4: MCP and bundled workflow (Stack C)

- [x] T020 [P] [US2] Add failing `jev_evaluate` registration and delegation tests in `tests/integrations/mcp-server.test.ts`
- [x] T021 [P] [US2] Add failing bundled-skill sync/discovery assertions in `tests/deploy/customer-vps/integrations-mcp-registration.test.ts` and the relevant skill-sync test
- [x] T022 [US2] Add the authenticated local-Gateway Jev client in `packages/kernel/src/tools/integrations.ts`
- [x] T023 [US2] Register `jev_evaluate` without credential/model/question arguments in `packages/integrations-mcp/src/server.ts`
- [x] T024 [US2] Author `skills/matrix/jev-email-triage/SKILL.md` with Gmail evidence, prompt-injection, authorization and policy rules
- [x] T024a [US2] Add Jev Inbox Triage as the 72nd Agent Recipes market card using Build in Chat and a reviewed Hermes bot configuration
- [ ] T024b [US2] Verify Build in Chat saves through the current user's authenticated Agent API and creates the bot in that user's Agent library with the selected Gmail account shown in Services; keep the generic MCP cross-principal failure tracked in ENG-12
- [ ] T024c [US2] Bind Hermes local MCP calls to the authenticated Chat run owner with a gateway-verifiable proof; retest collaborator account inventory in Preview before reading mail
- [x] T025 [US2] Synchronize generated skill artifacts through the repository's source mechanism and verify supported-agent discovery

## Phase 5: Gmail triage orchestration (Stack C)

- [ ] T026 [P] [US1] Add fixture tests for account selection, snippet/full-context preparation and hostile email instructions in `tests/gateway/jev-email-triage-workflow.test.ts`
- [ ] T027 [P] [US3] Add fixture tests for Gmail history fallback, fingerprints and repeat-run mutation suppression in `tests/gateway/jev-email-triage-workflow.test.ts`
- [ ] T028 [US1] Implement bounded Gmail thread normalization and latest-four-message verification in the smallest focused gateway/skill helper
- [ ] T029 [US1] Apply multi-label actions through existing `create_label` and `modify_message`; remove only `INBOX` for an authorized verified archive
- [ ] T030 [US3] Persist or reuse owner-scoped history/fingerprint state with documented retention and no raw body logs
- [ ] T031 [US1] Verify every classification/integration failure leaves the affected Gmail thread unchanged

## Phase 6: Acceptance, docs and release gate

- [ ] T032 [P] Run focused suites, `bun run typecheck`, `bun run check:patterns` and applicable full tests
- [ ] T033 [US1] Record an exact-head controlled-mailbox demo covering multi-label, Review, authorized archive and unavailable behavior
- [ ] T034 [US2] Verify one supported coding-agent invocation and a personal-primary-model run without provider switching
- [ ] T035 [US3] Verify duplicate execution produces one upstream dispatch, one settlement and one mutation set
- [ ] T036 Create a separate public documentation PR in `FinnaAI/matrix-os-site` covering funding, Gmail permissions, labels, archive and recovery
- [ ] T037 Complete CI, Greptile 5/5 and review gates; keep production availability disabled until runtime acceptance is recorded

## Dependency and stack order

`T001–T006` unblock the network layers. `T007–T013` unblock `T014–T019`. Stack B is independently acceptable after `T019`. Stack C begins at `T020`; Gmail mutations wait for the policy and Gateway contracts. Acceptance tasks start only after their referenced story is green.

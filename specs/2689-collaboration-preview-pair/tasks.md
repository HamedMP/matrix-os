# Tasks: Collaboration Preview Pair

**Input**: `specs/2689-collaboration-preview-pair/` — spec, plan, research, data model, contracts and quickstart.
**Tracking**: [ENG-418](https://linear.app/matrix-os/issue/ENG-418). Base: [spec PR #3022](https://github.com/HamedMP/matrix-os/pull/3022).
**Tests**: Mandatory TDD under the spec and constitution. Record named fault, actual
boundary and red/green evidence. Missing modules/fixture failures do not count as
regression protection. Required live prerequisites must never silently skip.

## Phase 1: Setup

- [x] T001 Verify the shared ENG-418 ticket, frozen spec head and native stack/worktree boundaries in `specs/2689-collaboration-preview-pair/plan.md`.
- [x] T002 Add and observe intended failing real Git/Bash feature-selection regressions in `tests/scripts/speckit-feature-paths.test.ts`.
- [x] T003 Fix validated metadata/explicit feature resolution and four-digit branch support in `.specify/scripts/bash/common.sh`, `setup-plan.sh`, `check-prerequisites.sh` and `update-agent-context.sh`; verify ten cases pass.
- [x] T004 Complete `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md` and the plan reference in `AGENTS.md`; validate prerequisite entrypoints and preserve the16-item requirements checklist.

## Phase 2: Foundational contracts and configuration

**Goal**: Strict producer/consumer contracts and test fixtures before story code.

- [x] T005 Add failing malformed/expired/duplicate-role/origin/source manifest cases in `tests/platform/preview-pair-contracts.test.ts`, then implement and export strict bounded contracts in `packages/contracts/src/preview-pair.ts` and its package export map.
- [x] T006 [P] Add failing disabled/invalid/overlapping fixture and isolation configuration cases in `tests/platform/preview-pair-config.test.ts`, then implement default-off configuration in `packages/platform/src/preview-pair/config.ts`.
- [x] T007 Define pair/generation/fixture/member table types and transactional migration in `packages/platform/src/preview-pair/types.ts` and `migration.ts`; wire only declarative types/migration registration into the existing database composition.
- [x] T008 Add real producer/consumer provenance tests in `tests/platform/preview-pair-provenance.test.ts` and implement trusted PR/run/artifact validation in `packages/platform/src/preview-pair/provenance.ts`.
- [x] T009 Prepare reusable actual PlatformDB fixtures and independent-connection Postgres qualification in `tests/platform/preview-pair-postgres-support.ts` and `preview-pair-postgres.test.ts`; ensure required lane configuration fails on missing prerequisites.

**Checkpoint**: Configuration fails closed; manifest/provenance contracts reject
untrusted input; database types/migrations and required test connection are ready.

## Phase 3: US1 — Obtain a matched pair (P1, MVP)

**Independent test**: An eligible request produces exactly two distinct test-owned
computers with one fixture organization and matching source; repeated requests
converge, one failed preparation rolls back both machines/jobs, and customer inventory
is unchanged. Candidate sharing may still fail and must remain diagnosable.

- [x] T010 [US1] Write failing two-job rollback, duplicate admission, fixture exclusivity and quota-race tests in `tests/platform/preview-pair-admission.test.ts` using the real transaction boundary.
- [x] T011 [US1] Add a transaction-required internal prepare-only mode in `packages/platform/src/customer-vps-provision.ts`; prove zero provider dispatch before commit and preserve ordinary Preview behavior.
- [x] T012 [US1] Implement admission/repository and guarded two-owner leases in `packages/platform/src/preview-pair/admission.ts` and `repository.ts`, invoking existing machine/job preparation and quota locks atomically.
- [x] T013 [P] [US1] Add failing auth/ownership/strict payload/body-limit cases in `tests/platform/preview-pair-routes.test.ts`, then implement bounded operator and real-session report routes in `packages/platform/src/preview-pair/routes.ts`.
- [x] T014 [US1] Add failing stale control/wrong running build/missing membership/funding cases in `tests/platform/preview-pair-readiness-postgres.test.ts`, then implement canonical readiness and report derivation in `packages/platform/src/preview-pair/readiness.ts`.
- [x] T015 [US1] Wire durable post-commit dispatch, trusted guarded host binding, reserved pair handles and Preview-sensitive guards through `packages/platform/src/preview-pair/service.ts`, `wiring.ts`, `customer-vps-preview.ts`, `customer-vps-schema.ts` and `packages/clerk-sync/src/index.ts`; test personal-account/customer boundary preservation.
- [x] T016 [US1] Write tests executing real controller helpers in `tests/platform/preview-pair-workflow.test.ts` and `tests/scripts/preview-pair-{control-workflow,controller-core,publisher-handoff}.test.ts`, then implement the protected request/report path in `.github/workflows/preview-collaboration-pair.yml` and `scripts/preview-pair/control.ts` with immutable execution-origin proof and no candidate operator secrets.
- [x] T017 [US1] Protect exact candidate desktop checkout/source validation with failing producer/consumer tests, then extend `.github/workflows/desktop-build.yml`, `scripts/release/build-source.mjs` and `desktop/electron.vite.config.ts` without changing normal release behavior.

## Phase 4: US2 — Open two independent Electron apps (P1)

**Independent test**: Launch two candidate apps from a canonical ready-pair fixture
alongside a normal third app. Each binds its expected actor/computer/org/source;
sign-out/relaunch/callback handling does not affect the other two sessions.

- [x] T018 [P] [US2] Add failing real AuthService cached/new wrong-actor, wrong-origin/slot and forbidden primary-fallback cases in `tests/desktop/preview-pair-auth.test.ts`.
- [x] T019 [US2] Implement expected pair context and auth binding in `desktop/src/main/preview-pair-context.ts`, `auth/preview-pair-binding.ts` and minimal `auth/auth-service.ts` wiring; preserve ordinary auth behavior.
- [x] T020 [P] [US2] Add failing candidate OTA/protocol ownership cases in `tests/desktop/preview-pair-startup.test.ts`, then disable updater and global protocol changes only for verified pair mode in the focused desktop startup/update helpers.
- [x] T021 [US2] Write canonical-lookup/artifact/source/expiry rejection tests in `tests/scripts/preview-pair-launch.test.ts`, then implement trusted control reads and artifact verification in `scripts/preview-pair/desktop-client.ts`, `artifact-download.ts` and `desktop-archive.ts`.
- [x] T022 [US2] Add failing traversal/symlink, repeated launch, partial startup and safe child-cleanup cases in `tests/scripts/preview-pair-profiles.test.ts`; implement owned profiles/processes in `desktop/src/main/preview-pair-profiles.ts`, `preview-pair-profile-lease.ts` and `scripts/preview-pair/desktop-process.ts`.
- [x] T023 [US2] Implement the thin dual-app command in `scripts/preview-pair/launch.ts` and the `preview:pair:open` package script using existing normal profile authentication; no token persistence or arbitrary target fallback.
- [x] T024 [US2] Add actual state-driven role/source/computer/org banner tests, then implement `desktop/src/renderer/src/features/preview/PreviewPairBanner.tsx` with bounded IPC and existing connection/organization stores; run React audit.
- [x] T025 [US2] Integrate minimal main-process/profile/IPC startup wiring and verify normal plus two candidate processes through `tests/e2e/desktop/preview-pair.e2e.test.ts`; missing artifacts/display must fail the required lane.

## Phase 5: US3 — Observe the real collaboration journey (P1)

**Independent test**: A fresh owner/member journey records actual publication,
member activation, inherited prompt persistence and outsider denial on exact builds.
A broken candidate records the failed product step while its healthy pair remains
available. No auth or private-directory shortcut may substitute for the real path.

- [x] T026 [US3] Add strict scenario-result and build-binding cases in `tests/platform/preview-pair-evidence.test.ts`, then implement bounded evidence/report handling in `packages/platform/src/preview-pair/evidence.ts`.
- [x] T027 [US3] Collect the eight retained first-party component/client/relay/owner authorization suites through `scripts/preview-pair/qualify-fixtures.ts` and its collector tests, including inherited Chat prompt execution; explicitly mark fixture boundaries.
- [x] T028 [US3] Implement the protected normal-login live acceptance entry in `scripts/preview-pair/qualify.ts`, covering fresh creation opt-in, separate first later Share, member Chat prompt/reopen and outsider denial; no generated peer sessions.
- [ ] T029 [US3] Capture equivalent Web Desktop and Electron Desktop observations using `specs/2689-collaboration-preview-pair/quickstart.md`; attach exact-build captures outside Git and record failed/not-run cases truthfully.

## Phase 6: US4 — Update, diagnose and retire pairs (P2)

**Independent test**: A new PR head leaves the active reproduction pinned and visibly
outdated. Explicit update resets into one new generation. Interrupted stop/delete
retains leases and capacity until exact provider absence is proved.

- [x] T030 [P] [US4] Add failing stale-claim, concurrent update/stop, hard-expiry and ambiguous deletion cases in `tests/platform/preview-pair-lifecycle.test.ts`.
- [x] T031 [US4] Implement generation-fenced claims, explicit clean-reset updates and access retirement in `packages/platform/src/preview-pair/lifecycle.ts`; do not extend expiry on replay.
- [x] T032 [US4] Implement durable exact-provider/machine-label absence proof and bounded retry in `packages/platform/src/preview-pair/cleanup.ts`, preserving existing deletion queue and customer behavior.
- [x] T033 [US4] Wire close/request-removal/expiry reconciliation, durable pre-admission cloud intent and cancellation recovery through `packages/platform/src/preview-pair/wiring.ts` and `.github/workflows/preview-collaboration-pair.yml`; keep unknown provider/PR state visible.
- [x] T034 [US4] Add source-currency observations and immutable generation evidence to `packages/platform/src/preview-pair/service.ts` and `readiness.ts`; a push must not silently replace either runtime or desktop build.
- [x] T035 [US4] Complete explicit owned-profile cleanup and repeated-launch reuse in `scripts/preview-pair/launch.ts`, `desktop-process.ts` and the shared desktop profile helpers; prove normal profiles and unrelated child processes remain untouched.

## Phase 7: Qualification, documentation and review

- [x] T036 Run focused real-boundary and independent Postgres qualification for `tests/platform/preview-pair-*.test.ts`; record exact results, rollback/race faults and every actual/synthetic boundary in `specs/2689-collaboration-preview-pair/validation.md`.
- [x] T037 Run applicable full typecheck, patterns, production shell, Electron production build/E2E and React audit; retain ordinary provisioning/auth/collaboration coverage and record results in `specs/2689-collaboration-preview-pair/validation.md`.
- [x] T038 [P] Update `docs/dev/collaboration-preview-pairs.md` and links from `docs/dev/preview-environments.md` with implemented commands, setup gates, login, reset, diagnosis, expiry and cleanup.
- [x] T039 Prepare and validate the separate `FinnaAI/matrix-os-site/content/docs/` documentation PR sharing ENG-418 and the native stack reference; do not publish private identities or committed captures.
- [ ] T040 Publish native stack layers, refresh their concise descriptions, request current-head Greptile once, resolve findings and monitor applicable CI through `docs/dev/stacked-prs.md`; do not merge.
- [ ] T041 Perform the reviewed scoped live pair/actual-target acceptance from `specs/2689-collaboration-preview-pair/quickstart.md` when approved isolation/fixtures/funding and local OS access exist; missing prerequisites remain explicit blockers, never completed tasks.
- [x] T042 Update ENG-418 with linked native stack, exact component results/evidence, recommended owner review and residual limitations recorded in `specs/2689-collaboration-preview-pair/validation.md`; keep it In Progress until delivery/acceptance completes.

## Dependencies and execution order

```text
T001–T004 -> T005–T009 -> US1(T010–T017)
                         -> US2(T018–T025, independently testable ready fixture)
US1 + US2 -> US3(T026–T029)
US1 data/claims -> US4(T030–T035); lifecycle safety is required before any paid activation
All code -> T036–T040 -> T041(live prerequisites) -> T042
```

Within each story, tests precede their implementation and shared-file mutations
remain sequential. T013 and T014 may be researched/tested independently after the
contracts; T018 and T020 touch separate tests; T030 cleanup fault cases can be
prepared while launcher work proceeds. Parallel examples do not authorize concurrent
edits to the same composition, schema or tasks file.

## GitHub Stack Plan

All layers share ENG-418 and the native GitHub stack rooted at spec PR #3022.
Use official `gh stack init/add/rebase/submit`; never hand-retarget or flatten.

| Layer | Scope | Suggested branch | Dependency |
| --- | --- | --- | --- |
| 0 | Published specification | `2689-collaboration-preview-pair` / #3022 | main |
| 1 | Plan/tasks and tested Spec Kit prerequisite | `codex/eng-418-preview-pair-foundation` | #3022 |
| 2a | Shared contracts, activation config, schema, provenance and real Postgres fixture (T005–T009) | `codex/eng-418-preview-pair-platform` | Layer1 |
| 2b | Atomic pair admission, guarded preparation and lifecycle/provider cleanup (T010–T012, T030–T032) | `codex/eng-418-preview-pair-lifecycle` | Layer2a |
| 2c | Operator/session API, readiness, reports and reconciliation (T013–T014, T034; production adapters from T015 remain in Layer3) | `codex/eng-418-preview-pair-api` | Layer2b |
| 3a | Protected unsigned exact-source packaging (T017) | `codex/eng-418-preview-pair-workflow` | Layer2c |
| 3b | Verified identity/provider readers, controller receipt ownership and guarded dispatcher (parts of T015–T016) | `codex/eng-418-preview-pair-controller` | Layer3a |
| 3c | Isolated two-database runtime projection and retirement tombstones (part of T015) / #3033 | `codex/eng-418-preview-pair-runtime` | Layer3b |
| 3d | Verified host/browser/API binding and pinned update policy (part of T015) | `codex/eng-418-preview-pair-host` | Layer3c |
| 3e | Exact projected collaboration access retirement and transaction-scoped late writer fences (part of T015/T033) | `codex/eng-418-preview-pair-operations` | Layer3d |
| 3f | Actual host observation and bounded scoped AI allowance (part of T015) | `codex/eng-418-preview-pair-maintenance` | Layer3e |
| 3g | Composed retirement and exact cloud cleanup (part of T015/T033) / #3042 | `codex/eng-418-preview-pair-composition` | Layer3f |
| 3h | Candidate runtime-only registration and startup isolation (part of T015) | `codex/eng-418-preview-pair-bootstrap` | Layer3g |
| 3i | Guarded runtime activation, maintenance and owned deletion composition (part of T015/T033) | `codex/eng-418-preview-pair-wiring` | Layer3h |
| 3j | Keep ordinary worker batches, metadata and deletion intents outside pair authority (part of T015) | `codex/eng-418-preview-pair-worker-boundaries` | Layer3i |
| 3k1 | Pinned source profile, isolated credential/target readers and current provider authority | `codex/eng-418-preview-pair-startup` | Layer3j |
| 3k2 | Configured Platform mount, worker and owned shutdown (complete T015; part of T033) | `codex/eng-418-preview-pair-startup-wiring` | Layer3k1 |
| 3l1 | Durable pre-publication request, early identity/isolation gate and atomic adoption (part of T016/T033) | `codex/eng-418-preview-pair-cloud-intents` | Layer3k2 |
| 3l2 | Claimed pre-admission recovery, exact cloud operation discovery and configured source retirement (part of T016/T033) | `codex/eng-418-preview-pair-automation` | Layer3l1 |
| 3l3 | Source-owned single-effect publisher and safe pre-admission reports (part of T016/T033) | `codex/eng-418-preview-pair-publisher` | Layer3l2 |
| 3l4a | Authenticated control transport, existing-pair reuse, fenced adoption/stop, controller completion recovery and bounded artifact reader (part of T016/T033) | `codex/eng-418-preview-pair-control` | Layer3l3 |
| 3l4b | Pair-only host bundle namespace, protected build/publish workflow and user command (complete T016/T033) | `codex/eng-418-preview-pair-control-workflow` | Layer3l4a |
| 4a | Source-verified Electron startup, owned profiles, account/runtime pinning and callback/OTA isolation (T018–T020; startup portion T025) | `codex/eng-418-preview-pair-desktop` | Layer3l4b |
| 4b | Artifact launcher, process reuse/cleanup and visible role (T021–T025, T035) | `codex/eng-418-preview-pair-launcher` | Layer4a |
| 5 if needed | Evidence runner, acceptance and internal docs (T026–T029, T036–T042) | `codex/eng-418-preview-pair-qualification` | Layer4 |

Target <1000 additions/<20 files where practical; split a layer before exceeding
3000 additions or50 files. Public-site docs live in their own repository/PR and
link this stack. Every phase is committed before adding its dependent branch.
No production activation or merges are authorized by these task checkboxes.

## Implementation strategy

US1 is the first useful MVP: a truthful, exact-source test pair with real owners,
reporting and safe cleanup. Continue through all requested stories; do not stop
at library scaffolding or claim two booted computers establish collaboration.
Unit/local tests keep first-party boundaries real; protected cloud/model/native
qualification is scoped and cost-bounded. Leave only genuinely unavailable
activation/device prerequisites open with evidence; complete independent code,
checks, documentation and review work first.

## Validation notes

- Setup helper: nine intended assertion failures observed before implementation;
  all ten cases pass after it. Initial sandbox fixture execution was not counted.
- Plan artifacts and relative links validate;16/16 specification checklist remains
  complete. Existing optional commit hooks are disabled; phase commits are explicit.
- No cloud setup, deployment, user grant/membership mutation or external Slack post
  occurred during planning/task generation.

- Protected control workflow T016/T033 and Electron T018–T025 are implemented;
  their focused validation notes describe real and synthetic boundaries.
- Qualification exports and actual fixture collection passed: 24 focused tests
  across three suites, plus 70 assertions across eight retained suites. The
  exact-checkout receipt remains fixture/productAcceptance:not_run.
- All eight official typechecks, canonical production shell build, parent
  Electron production build/native fixture journey and React audit passed.
- Public docs #322 passed hosted tests and 375/768/1280 responsive checks at
  `0a005b282c02cd1e4c6feedd0b7eb9370a9df224`; captures remain outside Git.
- ENG-418 is verified, assigned to Nima and updated with the final PR links.
  It remains In Progress.
- See `qualification-validation.md` for exact results, builds and limitations.
  Remaining T029/T040/T041 require live collaboration/evidence and review; no
  fixture result implies real-Clerk/two-VPS/model or native macOS acceptance.

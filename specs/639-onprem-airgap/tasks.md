# Tasks: on-premises and air-gapped Matrix OS

**Tracking:** [ENG-423](https://linear.app/matrix-os/issue/ENG-423). One shared task/stack ticket; do not create a ticket per PR layer.

**Input:** [spec.md](spec.md), [plan.md](plan.md), [research-runtime.md](research-runtime.md), [research-operations.md](research-operations.md), [licensing.md](licensing.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md).

**Status:** planned implementation, not implemented or runtime-qualified. Every checkbox is intentionally open. Paths not present at the baseline are proposed additions. Final names must follow the agreed contracts without duplicating an existing seam.

**Requester decision:** target AGPL core plus public commercial EE, following the PostHog-style layout. This selects the product direction; it does not adopt license text or establish rights to relicense/combine existing AGPL contributions. Restricted EE publication remains gated on legal/rightsholder clearance; shared AGPL core work proceeds independently. An all-AGPL design is a fallback if clearance fails, not the selected target.

## Execution rules

- Execute each behavior block as red → production implementation → green → fault/recovery check. Extend the closest effective existing suite before adding one. Record the user outcome, named fault and actual boundary; setup failure, text-presence checks or a permissive mock do not qualify a journey.
- `[P]` means files can be independently owned after the prerequisite row in the dependency table is complete. It never authorizes starting a dependent task early or concurrent edits to the same composition root.
- Security enforcement, local operation, owner export/recovery and generic adapter contracts remain in core. No feature flag, license condition or EE absence may weaken them. The commercial EE option remains subject to the rights/licensing decision.
- Use manual worktrees, explicit file commits, small native GitHub stacks, exact-head review and existing merge/evidence gates. Recommend product, engineering, security and affected integration-owner review; review recommendations are not new permission gates.
- A web-first demonstrator is an intermediate result. Full support requires Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile qualification. Offline source rebuilding is separate from disconnected installation.
- Browser interaction uses Codex's in-app browser. An external Chrome/Chromium/Playwright browser is not authorized by these tasks; obtain explicit current-task authorization if the in-app browser cannot perform a necessary interaction. Server/network harness scripts do not substitute for client visual evidence.

## Phase 1: baseline and evidence gates

- [ ] T001 Freeze the source baseline, supported feature inventory, current service calls and responsible owners in `specs/639-onprem-airgap/research-operations.md`; reconcile `research-runtime.md` against the selected release commit.
- [ ] T002 [P] Produce the install/first-use/periodic dependency inventory in `specs/639-onprem-airgap/dependency-inventory.md`, including child SDKs, Python/native/browser/model assets and app packages; reconcile the live dependency-advisory backlog by manifest, installed version, production/dev scope, shipped artifact and reachability, retaining sensitive triage outside the public repo.
- [ ] T003 [P] Run the exact-version local Pi/OpenCode route spike through Matrix admission, stream/read/cancel/restart and keyless/authenticated internal servers in `scripts/spikes/onprem-local-execution/`; record results in `specs/639-onprem-airgap/spike-results.md`.
- [ ] T004 Record supported OS/CPU/GPU, model/weights/quantization, context/concurrency and measured cold/warm latency/throughput/workload quality in `specs/639-onprem-airgap/reference-profile.md`; distinguish text/read-only proof from app-writing capability.
- [ ] T005 [P] Record the requester's AGPL-core/public-commercial-EE decision, contributor/rightsholder inventory, dependency/model redistribution review and pending-or-approved legal clearance in `specs/639-onprem-airgap/licensing.md`; shared AGPL work proceeds, restricted EE publication waits for rights and license approval.
- [ ] T006 [P] Refresh the architecture/threat boundary model and public-safe review coverage in `specs/639-onprem-airgap/security-plan.md`; keep unresolved vulnerability detail and exploit validation outside the public repository.
- [ ] T007 Resolve first demonstrator versus final support scope, excluded integrations and capacity/SLO decisions in `specs/639-onprem-airgap/spec.md` using T002–T004/T006 evidence; do not block shared AGPL core on a pending commercial decision or replace measurements with a fixed delivery-time promise.
- [ ] T008 Adopt the contracts, auth matrix, migration/versioning, trust-root custody, evidence storage and separate public-docs deliverable in `specs/639-onprem-airgap/plan.md`; record explicit unresolved go/no-go gates.

## Phase 2: shared foundation

- [ ] T009 Add failing producer/consumer tests in `tests/contracts/deployment-profile.test.ts` for contradictory profiles, accidental cloud fallback and undeclared capabilities; consume the production schemas.
- [ ] T010 Implement validated deployment capability and service-selection contracts in `packages/contracts/src/deployment-profile.ts`; distinguish hosted, standalone and enterprise composition without inferring capability from an environment flag alone.
- [ ] T011 [P] Add failing real-process tests in `tests/gateway/onprem-egress.test.ts` for child-process/network escape, hostname/redirect changes and cloud fallback; use a disposable network namespace/VM with approved internal endpoints.
- [ ] T012 Implement process-wide policy wiring in proposed `packages/gateway/src/inference-endpoints/policy.ts` and `distro/customer-vps/systemd/` profiles; installation operator owns the endpoint/CA/egress ceiling, org administrators may only narrow their own org scope, and cross-org policy changes or broader trust are denied.
- [ ] T013 [P] Add failing hosted/standalone composition regressions in `tests/gateway/deployment-composition.test.ts` and `tests/platform/deployment-composition.test.ts` that detect EE imports, missing dependencies and permissive auth fallbacks.
- [ ] T014 Extract focused deployment composition modules in `packages/gateway/src/deployment/` and `packages/platform/src/deployment/`; keep existing hosted defaults and canonical EU storage validation intact.
- [ ] T015 [P] Add failing principal/capability tests in `tests/contracts/deployment-principal.test.ts` for owner/org confusion, copied credentials and stale authority; exercise actual request-principal consumers.
- [ ] T016 Implement executor/artifact contracts in `packages/contracts/src/execution-backend.ts` and `offline-release.ts`, plus gateway `identity/provider.ts`/registration seams; resolve required dependencies at registration and reject incomplete configuration safely.

## Phase 3: US1 — useful local Matrix runtime (P1)

**Goal:** complete local Chat, approved writes/app creation, background work, App AI and Bots without cloud inference. **Independent check:** exact local model plus real gateway/Postgres/tool execution under denied external egress; restart, cancel and route-failure checks preserve effects and authority.

- [ ] T017 [US1] Extend `tests/gateway/generic-harness-model-catalog.test.ts` and `generic-native-profile-observation.test.ts` with failing keyless/private-endpoint/model-binding cases; catch models that list but cannot execute through real admission.
- [ ] T018 [US1] Implement approved internal endpoint/model/access-source handling in `packages/gateway/src/inference-endpoints/{registry.ts,transport.ts}`, `agent-config/base-url-policy.ts` and `ai-providers/`; preserve arbitrary-URL SSRF restrictions, exact route lineage and explicit keyless readiness without fabricated cloud credentials.
- [ ] T019 [US1] Add failing write-confinement and approval tests in `tests/gateway/pi-provider.test.ts` plus `tests/scope-runtime/`; detect protected-file, sibling-owner, credential/socket and unapproved LAN access through real subprocess tools.
- [ ] T020 [US1] Implement sandboxed local write execution in focused modules under `packages/gateway/src/coding-agents/` and `packages/scope-runtime/src/`; retain supervised/read-only modes until broader capability is enforceable.
- [ ] T021 [US1] Wire the qualified local executor into `packages/gateway/src/chat/coding-provider-adapter.ts` and focused registration modules; prove streaming, approval, cancellation, failures and restart/resume through canonical Chat events.
- [ ] T022 [P] [US1] Add failing app-build tests in `tests/gateway/app-runtime/build-orchestrator.test.ts` for unavailable packages/public-registry fallback; require persisted file/app output rather than a model claiming success.
- [ ] T023 [US1] Implement approved offline template/package resolution in `packages/gateway/src/app-runtime/build-orchestrator.ts`, `safe-env.ts` and `home/apps/`; rebuild/reopen a real Vite app using only included/internal dependencies.
- [ ] T024 [P] [US1] Add failing background-route tests in `tests/gateway/heartbeat/runner.test.ts` and dispatcher coverage; detect Claude/funded-source fallback, silent task loss and repeated uncertain writes after restart.
- [ ] T025 [US1] Implement `packages/gateway/src/execution/{backend.ts,local-pi-backend.ts,background-executor.ts}` and adapt `dispatcher.ts`/`heartbeat/runner.ts`; preserve backup/rollback, approvals, cancellation and explicit job route binding, with separate gateway-loss/native-process-loss recovery semantics.
- [ ] T026 [P] [US1] Extend `tests/gateway/app-ai-pi-sdk.test.ts` and `app-ai-pi-sdk-real.test.ts` with failing internal-source, model/route mismatch, no-tool, size/timeout and revocation cases using the actual worker/broker boundary.
- [ ] T027 [US1] Add local App AI admission/completion in `packages/gateway/src/app-ai/` and retire or adapt active Claude-only helper callers; retain text-only scope, grants, cancellation and no provider/account fallback.
- [ ] T028 [P] [US1] Extend `tests/gateway/bots/route-resolver.test.ts` and scope-runtime Bot coverage with failing local-source/credential-leak/tool-grant cases; implement the corresponding internal inference route in `packages/gateway/src/bots/` without opening worker LAN egress.
- [ ] T029 [US1] Implement explicit local or unavailable speech/image/search/MCP capability adapters in `packages/gateway/src/speech/`, `packages/kernel/src/image-gen.ts` and `packages/kernel/src/tools/`; test each advertised feature and safe missing-provider outcome before wiring.
- [ ] T030 [US1] Run the complete US1 real-runtime journey in proposed `scripts/qualification/airgap/local-runtime.ts`; retain exact build/model/workload evidence outside the repo and update `specs/639-onprem-airgap/spike-results.md` with honest coverage.

## Phase 4: US2 — offline install, update and recovery (P1)

**Goal:** install and maintain the supported computer from verified media/internal storage. **Independent check:** empty VM/caches with internet denied before installation; preserve owner data through crash, upgrade and restore to a second host.

- [ ] T031 [P] [US2] Add failing signed-manifest/import tests in `tests/scripts/offline-release.test.ts` for missing/transitively missing files, untrusted key, wrong platform, malicious archive paths and mutable payloads; execute the actual verifier.
- [ ] T032 [US2] Implement content-addressed manifest/signature/provenance verification in proposed `scripts/offline/verify-release.mjs`; include trust-root version, dependency/model identities, SBOM/notices and migration compatibility before any payload execution.
- [ ] T033 [US2] Add failing hosted-versus-standalone artifact/build-profile tests in `tests/scripts/offline-release.test.ts`, then deterministic export in `scripts/offline/export-release.mjs` and `scripts/build-host-bundle.sh`; remove Clerk/telemetry requirements only for the standalone profile while retaining hosted checks.
- [ ] T034 [US2] Extend `tests/scripts/self-host-installer.test.ts` with failing empty-cache first-boot cases, then implement local import in `scripts/offline/import-release.sh` and `scripts/install-server.sh`; preflight artifact/prerequisite closure before mutation.
- [ ] T035 [US2] Bundle/import pinned Postgres images or qualify a native Postgres option and all selected agent/editor/browser/Python runtimes in `distro/customer-vps/host-bin/matrix-postgres-start` and `matrix-install-*`; prove deferred first-use installation without external retries.
- [ ] T036 [P] [US2] Extend update regression coverage in `tests/platform/customer-vps-update-recovery.test.ts`, `customer-vps-update-manifest-trust.test.ts` and `tests/gateway/system-update.test.ts` with failing bad-signature, stale/wrong channel, unapproved downgrade, interrupted transaction and low-disk cases.
- [ ] T037 [US2] Add local artifact-source resolution to `distro/customer-vps/host-bin/matrix-sync-agent`, `matrix-update-manifest` and `packages/gateway/src/system-update.ts`; reuse the shared transaction/repair engine, antirollback rules and owner-data protection.
- [ ] T038 [US2] Prove key rotation/revocation and interrupted import/update recovery in proposed `scripts/qualification/airgap/update-recovery.ts`; include signed trust-root rollover, corrupt journal and database migration rollback limits without deleting recoverable state.
- [ ] T039 [P] [US2] Add failing real-Postgres/filesystem backup/restore tests in `tests/platform/offline-backup-restore.test.ts`; detect missing files/secrets, partial dump, wrong owner, corrupt payload and unavailable-versus-absent backup.
- [ ] T040 [US2] Implement local/internal destination, encryption/retention and consistent export/restore in `distro/customer-vps/host-bin/matrix-db-backup.sh`, `matrix-restore.sh` and shared backup adapters; restore onto a second clean host and measure RPO/RTO.
- [ ] T041 [P] [US2] Add failing inherited-telemetry-env, lazy-asset and remote-flag cases in `tests/shell/offline-network-policy.test.ts` and `tests/scripts/self-host-installer.test.ts`; inspect actual server and clean-client network attempts.
- [ ] T042 [US2] Implement offline defaults and local diagnostics in `packages/observability/src/`, `shell/next.config.ts`, `shell/src/lib/posthog-client.ts` and installer telemetry; keep diagnostic capture usable without external reporting/support services.
- [ ] T043 [US2] Add failing expiry/wrong-name/skew/rotation tests in `tests/scripts/offline-host-trust.test.ts`, then internal DNS/CA/time preflight and certificate lifecycle configuration in proposed `scripts/offline/configure-host.mjs` and nginx/service templates, with TLS verification enabled.
- [ ] T044 [US2] Run `scripts/qualification/airgap/offline-lifecycle.ts` on the selected reference hardware with empty caches; bind install, first-use tools, periodic tasks, app build, update, crash and second-host restore evidence to one immutable release.

## Phase 5: US3 — internal organization identity and control plane (P1)

**Goal:** multiple internal users collaborate under customer-owned authority. **Independent check:** real internal IdP/Postgres/storage plus two distinct users; cross-owner and revoked membership actions fail across API, WS and ongoing runs.

- [ ] T045 [P] [US3] Add failing internal-auth/principal/session tests in `tests/platform/internal-identity.test.ts` for wrong issuer/audience, identical subjects from foreign issuers, email reuse, stale membership, forged headers, replay and inactive users; exercise real token verification and membership data.
- [ ] T046 [US3] Implement generic internal OIDC/JWKS/session verification and mapping in shared `packages/gateway/src/identity/{provider.ts,principal-mapper.ts}` and platform adapters; bind installation+issuer+subject to immutable IDs, never email/raw subject/configured-owner fallback, with bootstrap/revocation/key rollover and no Clerk or EE prerequisite.
- [ ] T047 [US3] Add versioned owner-controlled Postgres migrations under proposed `packages/platform/src/database/migrations/enterprise-identity.ts` for internal users/org mappings and audit references; prove uniqueness/concurrency plus reviewed owner-data identity migration and restore without reassignment through email or fallback IDs.
- [ ] T048 [P] [US3] Add failing internal-storage and hosted-EU invariant tests in `tests/platform/object-storage-config.test.ts` and `tests/platform/home-mirror-env-check.test.ts`, then add deployment-specific validation in `packages/platform/src/deployment/` without weakening hosted rules.
- [ ] T049 [US3] Extend `tests/platform/organization-authority-postgres.test.ts` and `tests/gateway/collaboration-authority.test.ts` with failing internal-directory/relay, cross-org, revocation-during-run, stale generation and WS reconnect cases; retain real DB/runtime boundaries.
- [ ] T050 [US3] Wire internal directory/collaboration authority, relay, service identity and origins through `packages/platform/src/collaboration/` and `packages/gateway/src/collaboration/`; make T049 green while preserving signed attribution and fail-closed registration.
- [ ] T051 [P] [US3] Add failing startup cases without Stripe/Hetzner/Matrix funding/Pipedream to `tests/platform/deployment-composition.test.ts`, then implement explicit hosted-service exclusions in `packages/platform/src/deployment/`; reject accidental legacy container-orchestration activation.
- [ ] T052 [US3] Add failing delegated-identity/rotation/unavailable-service/scoped-write cases to existing `tests/integrations/` suites, then implement internal MCP/connector and OAuth issuer/callback policy in `packages/gateway/src/integrations/` and platform adapters.
- [ ] T053 [US3] Add failing mixed-version/key-expiry/revocation cases in `tests/platform/internal-identity.test.ts`, then customer-controlled secret/service-key rotation, backup custody and audit events in proposed `packages/platform/src/identity/key-lifecycle.ts`, without Matrix Cloud callbacks.
- [ ] T054 [US3] Run `scripts/qualification/airgap/internal-organization.ts` with actual IdP/storage/relay and two users; record create/join/leave/revoke/restore/reconnect and verify no actor becomes the shared standalone owner or widens installation policy.

## Phase 6: US4 — optional EE layer alongside the open core (P1)

**Goal:** one source line, independently useful core, optional enterprise composition and legally justified license boundary. **Independent check:** core builds/runs with EE physically absent; selected enterprise distribution satisfies its legal/entitlement contract offline.

- [ ] T055 [P] [US4] Add failing import/package/build boundary checks in proposed `tests/scripts/edition-boundaries.test.ts`; remove `ee/` from a disposable checkout and detect reverse imports, undeclared optional packages and EE-only startup requirements.
- [ ] T056 [US4] Implement one-way edition composition/export boundaries in `packages/contracts/src/deployment-profile.ts`, `pnpm-workspace.yaml`, optional `ee/` workspace manifests and `ee/server/composition.ts`; preserve the same core source revision and avoid duplicated gateway/shell/updater forks.
- [ ] T057 [US4] After T005 legal decision, add the approved license/notice structure and contributor guidance in `ee/LICENSE`, `ee/README.md` and `CONTRIBUTING.md`; preserve existing core notices/rights and accurately distinguish open source from source-available code.
- [ ] T058 [US4] Place selected SSO/directory lifecycle administration, policy/fleet UI and enterprise composition in `ee/{identity,admin,server}/`; keep generic identity/token verification, security/egress/export/update safety and standalone operation in core, and document file ownership in `ee/README.md`.
- [ ] T059 [US4] Add failing offline entitlement tests in proposed `tests/ee/offline-entitlement.test.ts` before implementation; detect remote call-home, wrong deployment binding, forged/expired/revoked grants and unsafe behavior on expiry/clock rollback.
- [ ] T060 [US4] Implement signed local entitlement verification and defined grace/recovery semantics in proposed `ee/license/offline-entitlement.ts`; expiry must not disable login to recover data, export/backup, security enforcement or safe shutdown, and must never broaden authorization.
- [ ] T061 [US4] Add community-absent-EE, existing-hosted, standalone and enterprise/offline CI jobs in proposed `.github/workflows/edition-qualification.yml`; run real required assertions and fail on missing prerequisites, empty collection or selected-lane skips.
- [ ] T062 [US4] Run edition/package/license artifact inspection in `scripts/qualification/airgap/edition-boundaries.ts`; prove an ordinary community checkout can build/use/export its data and an enterprise release shares the exact tested core revision.

## Phase 7: US5 — every included client works internally (P2)

**Goal:** all five named surfaces authenticate and use the same internal runtime. **Independent check:** cold clients with no Clerk/Matrix session or cache, internal CA installed, real API/WS/app/terminal requests, logout and reconnect.

- [ ] T063 [P] [US5] Extend `tests/shell/self-host-shell-mode.test.ts` and `proxy-auth.test.ts` with failing internal-user/bootstrap/WS cases; implement shared profile auth/org composition in `shell/src/app/layout.tsx` and focused `shell/src/lib/` adapters without hosted bypass regressions.
- [ ] T064 [P] [US5] Extend `tests/desktop/auth-service.test.ts` and `signin-device-auth.test.tsx` with failing internal-device/session/CA cases; implement an internal/standalone strategy in `desktop/src/main/auth/` with main-process credential custody and gateway-scoped CSP.
- [ ] T065 [P] [US5] Add failing fresh self-host startup/session tests in `apps/mobile/__tests__/auth.test.ts` and gateway-client suites; extract profile-driven bootstrap from `apps/mobile/app/_layout.tsx` so standalone does not instantiate or await Clerk.
- [ ] T066 [US5] Implement mobile internal auth/session recovery, logout, CA-compatible secure transport and REST/terminal WS/app paths in `apps/mobile/lib/` and `apps/mobile/components/auth/`; qualify exact installed iOS/Android builds with no Expo Go substitution.
- [ ] T067 [US5] Add capability-driven unavailable/enterprise administration states to shared `packages/ui/src/`, shell, Electron and mobile consumers; test each real component action and retain local safe errors without hidden hosted fallback.
- [ ] T068 [US5] Add failing exact-package/trust/update-source checks to existing `tests/desktop/` and mobile suites, then internal distribution/offline manifests in `desktop/`, `apps/mobile/` and `specs/639-onprem-airgap/client-distribution.md`; qualify OS restrictions independently of the server bundle.
- [ ] T069 [US5] Execute separate Web Canvas/Web Desktop/Electron Desktop/Web Mobile/Native Mobile journeys in `scripts/qualification/airgap/client-matrix.ts`; verify login, Chat/tool/write/app/terminal, cancel/restart/reconnect and revoked-session denial against real services.
- [ ] T070 [US5] Capture screenshots and recordings for each affected running surface outside the repository; index exact build/model/scenario, native OS/device and fixture limitations in `specs/639-onprem-airgap/quickstart.md` and attach actual evidence to the implementation PRs.

## Phase 8: US6 — security and independent qualification (P1)

**Goal:** validate real trust boundaries and close release-blocking defects. **Independent check:** security review receipts, real denial evidence and regression tests bound to the final artifact; no broad security claim from a static scan alone.

- [ ] T071 [P] [US6] Refresh source-backed security review for the chosen implementation revision and record reviewed/deferred surfaces in `specs/639-onprem-airgap/security-plan.md`; retain sensitive findings and validation output in private security artifacts.
- [ ] T072 [US6] Add named-fault authorization/tenant-isolation regressions to existing `tests/gateway/`, `tests/platform/` and `tests/scope-runtime/` suites; validate confirmed findings at their owning production boundary before changing code.
- [ ] T073 [US6] Fix confirmed security defects in their owning shared-core modules and rerun the original fault plus hosted/offline regressions; record sanitized remediation references in `specs/639-onprem-airgap/security-plan.md` without committing exploit recipes.
- [ ] T074 [P] [US6] Run actual process-tree/client egress verification in proposed `scripts/qualification/airgap/egress-audit.ts`; cover SDK/Python subprocesses, browser workers, generated apps, install hooks, DNS, redirects, cross-org policy escalation and periodic/expiry paths under installation-owned ceilings.
- [ ] T075 [P] [US6] Validate supply-chain trust and privilege boundaries in proposed `scripts/qualification/airgap/artifact-security.ts`; include signed import, key revocation, model custom code, dependency scripts, archive extraction/recovery and refreshed artifact-level dependency/OS/image/tool advisory triage with fixed/not-affected evidence and security-owner disposition.
- [ ] T076 [P] [US6] Run bounded exhaustion, slow/oversized stream, tool-loop, queue saturation, cancel/disconnect/restart and shutdown-drain tests in proposed `scripts/qualification/airgap/resource-lifecycle.ts` on measured reference capacity.
- [ ] T077 [US6] Re-check Daybreak Blue availability against the selected immutable source/artifact; record actual access and, when available, authorized scan ID/scope/coverage/triage in `specs/639-onprem-airgap/security-plan.md`; an unavailable result completes this access check but never counts as a passed Blue scan.
- [ ] T078 [US6] Obtain independent security-owner review after fixes through Daybreak Blue or an explicitly approved alternative when access remains unavailable; record the alternative decision, actual review evidence, accepted residual risks and release decision in `specs/639-onprem-airgap/security-plan.md`.
- [ ] T079 [US6] Run the full cold-install/internal-org/client/upgrade/second-host-restore exercise from `specs/639-onprem-airgap/quickstart.md`; selected runtime/model/DB/device lanes must execute assertions and fail if unavailable or skipped.
- [ ] T080 [US6] Produce the exact-artifact qualification record and signed provenance/SBOM/notice bundle under release output, with public-safe index in `specs/639-onprem-airgap/qualification.md`; block supported-release claims on unresolved mandatory security/runtime/surface evidence.

## Phase 9: documentation, handoff and release review

- [ ] T081 Create a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` covering supported profiles, licenses, hardware/model evidence, installation, internal CA/IdP/storage, exclusions and offline lifecycle/recovery.
- [ ] T082 Publish public-safe operator/support runbooks in `docs/dev/onprem-operations.md` and `ee/README.md` as applicable; keep customer identifiers, credentials, access commands and sensitive incident/security detail in the private support system.
- [ ] T083 Reconcile every task and unresolved decision in `specs/639-onprem-airgap/qualification.md` with ENG-423 and each stack/PR; attach actual visual evidence and link Slack `#tech` evidence only through an explicitly authorized communication step.
- [ ] T084 Prepare the reviewed release candidate and rollback/support plan in `specs/639-onprem-airgap/release-checklist.md`; verify exact-head Greptile 5/5 or accepted carry-over, required CI and ticket/evidence gates before requesting any production release/merge action.

## Dependencies and critical path

Within a row, task ordering is left-to-right unless an explicit independent branch is shown. Every implementation task requires its named tests red first. A task mentioning both tests and implementation must record that order in its PR.

| Tasks | Prerequisites | Parallel execution allowed after prerequisites |
|---|---|---|
| T001 | none | none |
| T002, T003, T005, T006 | T001 | independent inventory/runtime/legal/security owners |
| T004 | T003 | capacity work can overlap legal/security research |
| T007 → T008 | T002–T004, T006 | none; scope/contracts gate; pending T005 commercial approval does not block shared AGPL core |
| T009 → T010 | T008 | none |
| T011 → T012 | T010 | with T013 and T015 test authors on separate files |
| T013 → T014; T015 → T016 | T010 | independent before shared composition integration; serialize common registration files |
| T017 → T018 → T019 → T020 → T021 | T012, T014, T016, T004 | local executor critical path |
| T022 → T023 | T012, T016, T018 | package/build owner; integration waits for T020 |
| T024 → T025 | T012, T016, T020 | background owner, serialize dispatcher composition |
| T026 → T027; T028 | T012, T016, T018 | App AI and Bot owners separate directories; no broadening of sandbox |
| T029 → T030 | T021, T023, T025, T027, T028 | auxiliary capability owner can prepare after T016; final integration joins all runtime work |
| T031 → T032 → T033 → T034 → T035 | T008, T010, T004 | packaging branch independent of AI after model/dependency identity is fixed |
| T036 → T037 → T038 | T012, T016, T032 | update owner separate from installer; share verifier contract |
| T039 → T040 | T016, T032 | backup owner separate from update engine |
| T041 → T042; T043 | T012, T014 | telemetry/assets and host PKI owners separate files |
| T044 | T030, T035, T038, T040, T042, T043 | joins runtime and lifecycle; no release qualification before this |
| T045 → T046 → T047 | T012, T014, T016 | shared verification/mapping independent of runtime and EE/legal decisions; enterprise administration is T058 |
| T048 | T014, T016 | storage validation owner; coordinate platform composition |
| T049 → T050 | T046, T047, T048 | collaboration owner with identity contract fixed |
| T051; T052; T053 | T046, T047, T048 | service composition, connector and key-lifecycle owners; serialize overlapping wiring files |
| T054 | T049–T053 | full organization integration |
| T055 → T056 | T008, T016 | edition boundary branch independent of AI/lifecycle |
| T057 → T058 | T005 completed rights/license approval, T056 | pending rights do not satisfy this gate; shared AGPL core extraction continues independently |
| T059 → T060 | T005 completed rights/license approval, T056, T053 | optional commercial entitlement branch; omit only if approved license option needs none |
| T061 → T062 | T056, T058, T060 | community and hosted checks can start at T056; final enterprise lane joins selected EE features |
| T063; T064; T065 → T066 | T016, T046, T049 | web, Electron and native owners; backend contract fixed |
| T067 → T068 → T069 → T070 | T063–T066, T030, T054, T060 | capability UI/distribution preparation can overlap client work; final journeys join all |
| T071 → T072 → T073 | first implementation candidate; repeat against final candidate | initial audit can proceed alongside development; fixes belong to owning modules |
| T074; T075; T076 | T044, T054, T062, T069 | egress, artifact and resource reviewers on separate harness files |
| T077 → T078 | T071–T076, final source candidate | access check can occur earlier; independent final review follows fixes |
| T079 → T080 | T070, T073–T078 | final qualification joins every included profile/surface |
| T081; T082 | supported behavior from T044/T054/T069 | docs owners, separate site repo; draft earlier, finalize against evidence |
| T083 → T084 | T080–T082 | final decision, no implied release permission |

Critical path: T001 → T003/T004 → T007/T008 → T009/T010 → shared enforcement/composition → local write executor → complete AI/app/background runtime → cold offline lifecycle → all clients/internal org → independent security → final exact-artifact qualification. Legal work runs in parallel but blocks proprietary EE distribution. No 8–12-week commitment is made before spikes and staffing estimates.

## GitHub Stack Plan

Use `docs/dev/stacked-prs.md` and official `github/gh-stack`; aim below 1000 additions/20 files per layer and split before repository hard limits. Every layer links ENG-423, this spec and its named native stack. Publish draft layers as reviewable work; never flatten independently completed phases into one large PR.

| Stack / layer family | Tasks | Review boundary |
|---|---|---|
| `onprem-foundation`: planning → contracts → egress → composition | T001–T016 | independent spec first; separate core contracts/security/composition layers |
| `onprem-local-runtime`: endpoint/catalog → sandboxed writes → Chat → app packages → background → App AI → Bots/auxiliary | T017–T030 | branch from accepted foundation; separate owner/capability boundaries |
| `onprem-offline-lifecycle`: verifier → export/build → install/firstboot → update → backup/restore → telemetry/PKI | T031–T044 | independent packaging/update/recovery layers; final integration layer depends on runtime |
| `onprem-internal-organization`: identity → schema → storage → collaboration → connectors/rotation | T045–T054 | independent from runtime after shared contracts; preserve hosted behavior each layer |
| `onprem-editions`: import boundaries → approved license notices → optional EE composition → entitlement → CI | T055–T062 | license/rights decision before commercial file publication; shared core never imports EE |
| `onprem-clients`: web → Electron → mobile bootstrap → mobile sessions → shared capabilities/distribution | T063–T070 | separate client layers may run in parallel against internal identity contract |
| `onprem-qualification`: confirmed fixes → adversarial tests → independent security → exact-artifact acceptance → docs/release handoff | T071–T084 | sensitive security details private; public-safe fixes/specs and site-docs PR separate |

Each family may contain multiple small native stacks if changes are independent. Stack link/dependency metadata must match actual code dependencies. Recheck review carry-over after restacks; new changes need fresh review. When the current reviewed head reaches Greptile 5/5, add `ready-for-ci`. Cleanup completed worktrees only after merge and verified absence of unfinished state/processes.

## Suggested requester-assigned work packages

Keep ENG-423 as the shared umbrella. If planning benefits from child issues, use these concise briefs and links to the relevant task ranges; do not create duplicates automatically.

| Package | Brief |
|---|---|
| Reference profile and contracts | Goal: fix supported scope with measured evidence. Do: T001–T016. Done when: local capability/capacity spike and reviewed contracts define executable bounds. |
| Local execution | Goal: complete useful Matrix work on internal inference. Do: T017–T030. Done when: real Chat/app/background/App AI/Bot effects survive recovery without egress. |
| Offline lifecycle | Goal: install and recover from verified local artifacts. Do: T031–T044. Done when: clean-host install/update/crash/second-host restore passes. |
| Internal organization | Goal: customer-controlled multiuser authority. Do: T045–T054. Done when: two-user collaboration and revocation pass using internal services only. |
| EE and coexistence | Goal: optional EE without a core fork or unsupported relicensing. Do: T055–T062. Done when: rights decision, absent-EE core and selected offline EE behavior pass. |
| All clients | Goal: five surfaces work against internal services. Do: T063–T070. Done when: exact packaged/browser/native flows and evidence pass independently. |
| Security qualification | Goal: validate and remediate actual trust-boundary defects. Do: T071–T080. Done when: required independent review and exact-artifact security/runtime gates pass. |
| Documentation and handoff | Goal: make supported operation reviewable and repeatable. Do: T081–T084. Done when: site docs/runbooks/evidence and reviewed release candidate are linked. |

## Implementation strategy

Start with a web-first local read-only spike, then a sandboxed write/app/background demonstrator. That milestone is deliberately narrower than the final product. Continue offline lifecycle and enterprise identity work on separate branches once shared contracts settle. Native clients and EE rights work run in parallel; merge readiness depends on their own evidence. Final support is declared only for the exact profile/artifact/hardware/surface combination that passed, with every excluded feature visible and documented.

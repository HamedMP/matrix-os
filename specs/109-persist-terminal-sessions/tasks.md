# Tasks: Persistent Terminal Sessions Across Deployments

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`
**Testing rule**: every implementation task follows Red → Green → Refactor; tests listed before production code are mandatory.

## Phase 1: Mandatory Spike Gate

**Goal**: produce auditable S1/S2 evidence on the exact `v0.44.3-matrix.1` production-candidate bytes before production implementation.

- [X] T001 Add failing manifest/redaction/limit tests for the spike evidence validator in `tests/scripts/terminal-runtime-spike.test.ts`
- [X] T002 Implement the bounded evidence validator in `scripts/spikes/terminal-runtime/verify-evidence.mjs`
- [X] T003 Add the fixed spike slice and template unit in `scripts/spikes/terminal-runtime/matrix-terminal-spike.slice` and `scripts/spikes/terminal-runtime/matrix-terminal-spike@.service`
- [X] T004 Implement the foreground node-pty keeper probe with readiness and deterministic exit recording in `scripts/spikes/terminal-runtime/keeper.mjs`
- [X] T005 Implement S1 process/cgroup/readiness/termination/resource-pressure orchestration in `scripts/spikes/terminal-runtime/run-remote.sh`
- [X] T006 Implement S2 exact-option/cache/viewport/scrollback/gating/corruption/deletion/pressure orchestration in `scripts/spikes/terminal-runtime/run-remote.sh`
- [X] T007 Add the secret-safe same-repository preview-VPS workflow and post-merge manual rerun path in `.github/workflows/terminal-runtime-spikes.yml`
- [X] T008 Document local and remote spike operation in `scripts/spikes/terminal-runtime/README.md`
- [ ] T009 Run the workflow on the PR preview VPS and record the run/artifact digest, source/patch/binary digests, and S1/S2 result in `specs/109-persist-terminal-sessions/evidence/README.md`

**Independent test**: the workflow fails for any missing invariant, build-identity mismatch, or privacy violation and succeeds only with `summary.json` reporting both gates passed on the exact `v0.44.3-matrix.1` bytes.

---

## Phase 2: Foundational Privilege and Runtime Boundary

**Prerequisite**: T009 records S1 and S2 passing. If not, stop and amend the spec.

- [ ] T010 Add failing runtime ID, protocol framing, unknown-key, injection, and executor-not-called tests in `tests/terminal-runtime/contracts.test.ts`
- [ ] T011 Add failing receipt/name-index/descriptor schema and state-transition tests in `tests/terminal-runtime/storage-contracts.test.ts`
- [ ] T012 Add failing symlink, hard-link, no-follow, atomic publish, stale descriptor, and cleanup tests in `tests/terminal-runtime/filesystem-security.test.ts`
- [ ] T013 Create the strict shared protocol/lifecycle schemas in `packages/terminal-runtime/src/contracts.ts`
- [ ] T014 Implement bounded framing and the unprivileged protocol client in `packages/terminal-runtime/src/client.ts`
- [ ] T015 Implement pinned-parent, exclusive, fsynced receipt/name-index storage in `packages/terminal-runtime/src/storage.ts` and `packages/terminal-runtime/src/receipts.ts`
- [ ] T016 Implement one-shot descriptor publication, claim, cleanup, and caps in `packages/terminal-runtime/src/descriptors.ts`
- [ ] T017 Implement the minimal peer-credential acceptor in `packages/terminal-runtime/native/supervisor-acceptor.c`
- [ ] T018 Implement the seven-operation fixed TypeScript handler and systemd executor seam in `packages/terminal-runtime/src/operation-handler.ts`
- [ ] T019 Implement reconciliation evidence precedence and deterministic failure recording in `packages/terminal-runtime/src/reconciliation.ts`
- [ ] T020 Implement keeper PTY launch, cgroup verification, readiness, monitoring, and sd_notify in `packages/terminal-runtime/src/keeper.ts`
- [ ] T021 Add package build/typecheck entry points and native build in `packages/terminal-runtime/package.json` and `packages/terminal-runtime/tsconfig.json`
- [ ] T022 Add fixed wrappers and versioned support installation in `distro/customer-vps/host-bin/matrix-terminal-supervisor`, `distro/customer-vps/host-bin/matrix-terminal-keeper`, `distro/customer-vps/host-bin/matrix-terminal-pane`, and `distro/customer-vps/host-bin/matrix-terminal-runtime-op`
- [ ] T023 Add the stable supervisor, slice, and non-enabled template in `distro/customer-vps/systemd/matrix-terminal-runtime.service`, `distro/customer-vps/systemd/matrix-terminal.slice`, and `distro/customer-vps/systemd/matrix-terminal-session@.service`
- [ ] T024 Add atomic stable-libexec/unit installation and supervisor compatibility checks in `scripts/build-host-bundle.sh` and `distro/customer-vps/host-bin/matrix-sync-agent`
- [ ] T025 Replace unrestricted sudo with separately typed fixed helpers and tests in `distro/customer-vps/cloud-init.yaml`, `distro/customer-vps/host-bin/`, and `tests/gateway/customer-vps-host.test.ts`

**Independent test**: invalid requests never reach the injected systemd executor; a valid fixed-template start owns one cgroup and survives gateway shutdown; production client startup fails closed without protocol v1.

---

## Phase 3: User Story 1 — Deployment-Surviving Shell and Agent Runtimes (P1)

- [ ] T026 [P] [US1] Add failing production fail-closed and local direct-spawn tests in `tests/gateway/terminal-runtime-client.test.ts`
- [ ] T027 [P] [US1] Add failing shell create/list/attach/delete immutable-runtime integration tests in `tests/gateway/shell-terminal-runtime.test.ts`
- [ ] T028 [P] [US1] Add failing agent stdin/FD launch and sensitive-argv scan tests in `tests/gateway/agent-terminal-runtime.test.ts`
- [ ] T029 [US1] Inject one compatible runtime client at terminal route registration in `packages/gateway/src/server.ts` and `packages/gateway/src/shell/runtime-client.ts`
- [ ] T030 [US1] Route production shell creation/list/attach/delete through runtime IDs while retaining local node-pty in `packages/gateway/src/shell/zellij.ts` and `packages/gateway/src/shell/registry.ts`
- [ ] T031 [US1] Route coding-agent terminal creation and liveness through supervised runtimes in `packages/gateway/src/zellij-runtime.ts` and `packages/gateway/src/agent-session-service.ts`
- [ ] T032 [US1] Remove prompts/settings/cwd/dynamic options from Matrix-managed provider argv/layouts by using stdin or anonymous FDs in `packages/gateway/src/agent-launcher.ts` and `packages/gateway/src/coding-agents/`
- [ ] T033 [US1] Preserve attach PTYs in the gateway cgroup and drain only subscribers/attach clients on shutdown in `packages/gateway/src/shell/terminal-websocket.ts` and `packages/gateway/src/server.ts`

**Independent test**: gateway crash/restart changes only gateway and attach PIDs; keeper, server, shell, and agent stay unchanged and attachable.

---

## Phase 4: User Story 2 — Explicit Safe Recovery (P1)

- [ ] T034 [P] [US2] Add failing empty-body/auth/rate-limit/idempotency/generic-error recovery route tests in `tests/gateway/terminal-recovery-route.test.ts`
- [ ] T035 [P] [US2] Add failing valid/corrupt/missing/incompatible Zellij cache recovery tests in `tests/terminal-runtime/recovery.test.ts`
- [ ] T036 [P] [US2] Add failing interrupted-state and no-silent-recreation client/store tests in `shell/src/components/terminal/__tests__/TerminalApp.test.tsx`
- [ ] T037 [US2] Add `POST /api/terminal/sessions/:name/recover` with shared limiter and strict empty body in `packages/gateway/src/shell/routes.ts` and `packages/gateway/src/server.ts`
- [ ] T038 [US2] Implement explicit serialized/fresh-shell recovery and bounded reasons in `packages/terminal-runtime/src/reconciliation.ts` and `packages/terminal-runtime/src/keeper.ts`
- [ ] T039 [US2] Publish and install the exact S2-proven `v0.44.3-matrix.1` binary digest, then configure its serialization/cache options without force-run in `packages/gateway/src/shell/zellij-config.ts` and `packages/terminal-runtime/src/zellij.ts`
- [ ] T040 [US2] Render Interrupted/Recoverable state and explicit Recover action Canvas-first in `shell/src/components/terminal/TerminalApp.tsx` and shared terminal stores
- [ ] T041 [US2] Add terminal-history privacy disclosure and safe bounded client error allowlisting in `shell/src/components/terminal/` and `docs/platform/user/terminal.md`
- [ ] T042 [US2] Run `npx react-doctor@latest shell` and capture Canvas/Desktop recovery screenshot evidence in the PR body

**Independent test**: reboot starts no terminal/command/agent; explicit recovery restores valid bounded state with commands gated or starts a fresh safe shell with a generic reason.

---

## Phase 5: User Story 3 — Immutable Rename and Multi-Device Identity (P1)

- [ ] T043 [P] [US3] Add failing Rename/Rename, Rename/Recover, Recover/Recover, and alias-expiry tests in `tests/terminal-runtime/concurrency.test.ts`
- [ ] T044 [P] [US3] Add failing runtime-ID layout migration tests in `shell/src/stores/__tests__/terminal-layout.test.ts`
- [ ] T045 [US3] Change rename to metadata/name-index only under ordered locks in `packages/terminal-runtime/src/operation-handler.ts` and `packages/gateway/src/shell/registry.ts`
- [ ] T046 [US3] Add additive runtime/lifecycle projection fields to list contracts in `packages/gateway/src/shell/routes.ts` and shared shell types
- [ ] T047 [US3] Store runtime ID plus display metadata and resolve bounded aliases in shared Canvas/Desktop terminal layout state
- [ ] T048 [US3] Ensure multi-device attach resolves existing runtime only and never calls Create/Recover in `packages/gateway/src/shell/terminal-websocket.ts`

**Independent test**: two devices and all rename/recover races preserve one runtime ID, unit, Zellij session, and process tree.

---

## Phase 6: User Story 4 — Complete Irreversible Delete (P2)

- [ ] T049 [P] [US4] Add failing populated-cgroup, partial-stop, idempotent, and Recover/Delete race tests in `tests/terminal-runtime/delete.test.ts`
- [ ] T050 [US4] Commit deleting intent, notify clients, stop the fixed unit, and poll bounded `cgroup.events` in `packages/terminal-runtime/src/operation-handler.ts`
- [ ] T051 [US4] Remove receipt/index/agent/scrollback/Zellij state only after `populated 0` in `packages/terminal-runtime/src/storage.ts` and gateway cleanup integration
- [ ] T052 [US4] Make reaper/accounting skip live, activating, recovering, and deleting-populated runtimes in `packages/terminal-runtime/src/reconciliation.ts`

**Independent test**: Delete empties the complete cgroup before removing every runtime-owned state set and later Recover cannot recreate it.

---

## Phase 7: User Story 5 — Narrow Observable Operator Boundary (P2)

- [ ] T053 [P] [US5] Add fuzzed framing/injection and journal/argv/environment privacy tests in `tests/terminal-runtime/security.test.ts`
- [ ] T054 [P] [US5] Add disk/count/TTL/symlink-safe recurring cleanup tests in `tests/terminal-runtime/resource-management.test.ts`
- [ ] T055 [US5] Add bounded lifecycle metrics and truncated runtime hashes in `packages/terminal-runtime/src/telemetry.ts`
- [ ] T056 [US5] Implement inactive retention, disk attribution, pressure pruning, and timer shutdown in `packages/terminal-runtime/src/reconciliation.ts`
- [ ] T057 [US5] Add supervisor/descriptor/receipt/cgroup aggregate health without sensitive detail in gateway/operator health projections

**Independent test**: every out-of-scope input is rejected before systemd; telemetry and journals contain only allowed coarse fields; caps remain enforced under pressure.

---

## Phase 8: User Story 6 — Legacy and Deployment Migration (P3)

- [ ] T058 [P] [US6] Add failing updater stop-allowlist, rollback, atomic stable-install, and no-instance-enable tests in `tests/gateway/customer-vps-host.test.ts`
- [ ] T059 [P] [US6] Add failing legacy name/cwd migration and no-PID-adoption tests in `tests/terminal-runtime/legacy-migration.test.ts`
- [ ] T060 [US6] Enforce updater stop allowlists and atomic stable helper installs in `distro/customer-vps/host-bin/matrix-sync-agent`
- [ ] T061 [US6] Install/enable only the stable supervisor and never template instances in `distro/customer-vps/cloud-init.yaml` and `scripts/install-server.sh`
- [ ] T062 [US6] Migrate validated legacy metadata to interrupted/recoverable immutable receipts in `packages/terminal-runtime/src/legacy-migration.ts`
- [ ] T063 [US6] Add the one-time migration interruption and no-adoption disclosure to repository operator/user docs

**Independent test**: the first release reports one honest interruption; every later bundle/rollback leaves active runtime PIDs/cgroups unchanged.

---

## Phase 9: Polish and Production-Representative Acceptance

- [ ] T064 Run focused tests, `bun run typecheck`, `bun run check:patterns`, `bun run test`, and applicable React audit in every stack worktree
- [ ] T065 Execute the complete disposable-VPS matrix across two bundles, forced failure, rollback, reboot, concurrency, corruption, and delete; link bounded evidence in `specs/109-persist-terminal-sessions/evidence/README.md`
- [ ] T066 Amend lifecycle/persistence/reaper/gateway-shutdown text in `specs/107-terminal-multi-device/spec.md` to match measured behavior
- [ ] T067 Publish verified lifecycle/privacy/migration documentation in the separate `FinnaAI/matrix-os-site` PR and link it from the final rollout PR

## Dependencies

```text
Spike Gate -> Foundation -> US1 runtime ownership -> US2 recovery
                                      |             -> US3 identity
                                      |             -> US4 delete
                                      |             -> US5 operations
                                      \----------------> US6 rollout -> acceptance/docs
```

- T009 blocks T010 and all production work.
- Foundation T010–T025 blocks every user story.
- US1 blocks UI recovery and legacy rollout because it establishes authoritative runtime ownership.
- US2/US3/US4 can be reviewed as separate upstack layers after US1, but their shared files require sequential implementation/restacking.
- US6 and final acceptance require every earlier lifecycle contract.

## Parallel Examples

- US1: T026, T027, and T028 are independent failing suites before T029–T033.
- US2: route, recovery-engine, and React tests T034–T036 can be red in parallel.
- US3: server concurrency T043 and layout migration T044 touch separate surfaces.
- US5: security and resource tests T053–T054 are independent before implementation.
- US6: updater and legacy migration tests T058–T059 are independent.

## Graphite Stack Plan

| Stack | Tasks | Conventional PR title |
|---:|---|---|
| 1/6 | T001–T009 plus plan artifacts | `test(terminal): prove persistent runtime invariants` |
| 2/6 | T010–T025 | `feat(terminal): add supervised runtime foundation` |
| 3/6 | T026–T033, T043–T048, T049–T052 | `feat(terminal): migrate shell and agent runtimes` |
| 4/6 | T034–T042 | `feat(terminal): add explicit recovery experience` |
| 5/6 | T053–T063 | `feat(terminal): preserve runtimes through updates` |
| 6/6 | T064–T067 | `docs(terminal): verify persistent runtime rollout` |

Use `gt create`, `gt modify`, `gt restack`, and `gt submit --stack`. Never flatten
the stack. If a layer approaches 3,000 additions or 50 files, split it again at
the test/host/gateway boundary before publication.

## MVP

The minimum safe increment is Stack 1 only: reproducible proof that the selected
architecture is viable. It deliberately delivers no production behavior. The
minimum user-visible feature is Stacks 1–4; delete, privilege reduction, updater,
and migration remain release blockers even if reviewed in later layers.

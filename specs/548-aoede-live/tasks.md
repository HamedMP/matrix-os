# Tasks: Aoede Live

Input: approved spec.md, plan.md and research.md. Work on `548-aoede-live`, based on PR #2040; no new worktrees. Optional Spec Kit git-commit hooks are not invoked during the shared-directory batch.

## Setup and foundation

- [x] T001 Publish shared session/event boundaries in packages/contracts/src/aoede.ts and specs/548-aoede-live/contracts/aoede-api.md.
- [x] T002 Establish gateway composition and authenticated socket dispatch in packages/gateway/src/server.ts and packages/gateway/src/server/main-ws-routes.ts.

## US1: conversation lifecycle (P1)

Independent proof: denied microphone causes no mint; another runtime cannot attach; duplicate mint cannot spend twice; close settles once; missing usage remains uncertain.

- [x] T003 [P] [US1] Write focused lifecycle/funding failures first in tests/platform/aoede-live.test.ts; implement funded mint, trusted sideband and restart cleanup in packages/platform/src/aoede/ and platform-owned wiring/config/funding files.
- [x] T004 [P] [US1] Write checkpoint/startup/supersession regressions first in tests/gateway/aoede/session.test.ts; implement owner SQL session/delegation storage, transcripts, prompt, runtime client and routes in packages/gateway/src/aoede/{session,repository,transcript,prompt,platform-client,routes}.ts.
- [ ] T005 [P] [US1] Implement media lifecycle and overlay using existing socket/visibility store in shell/src/aoede/, shell/src/components/Desktop.tsx and shell-owned consumers. Verify startup failure cleanup and stale-tab close in browser.
- [ ] T006 [US1] Integrate and verify lifecycle/funding before enabling delegation in packages/gateway/src/server.ts.

## US2: direct actions (P1)

Independent proof: unauthorized/ambiguous action has no effect; rich Notes content survives append; window success requires the invoking shell result; facts survive reload.

- [x] T007 [P] [US2] Write persistence/action failures first in tests/gateway/aoede/actions.test.ts; implement strict classifier, registry-backed Notes SQL and profile actions in packages/gateway/src/aoede/actions.ts and packages/gateway/src/vocal/profile.ts.
- [ ] T008 [US2] Connect correlated UI actions through existing /ws in packages/gateway/src/server/main-ws-routes.ts and shell/src/aoede/useAoedeSession.ts; exercise Web Canvas and Web Desktop.

## US3/US4: durable Chat delegation (P2/P3)

Independent proof: duplicate delegation admits once; busy Chat queues; voice cannot bypass platform approval proof; long build completes after subscription touch; recovery does not rerun work.

- [x] T009 [US3] Write admission/approval/cancel regressions first in tests/gateway/aoede/delegate-postgres.test.ts; implement canonical admission, events, cancellation and sole low-risk shell approval relay in packages/gateway/src/aoede/delegate.ts.
- [x] T010 [US4] Verify current-information/workspace requests use canonical Chat and verified results in tests/gateway/aoede/delegate-postgres.test.ts.

## Replacement, docs and qualification

- [ ] T011 Remove legacy Vocal transport only after replacement qualifies; update gateway auth/route inventory and shell consumers, preserving profile/store.
- [ ] T012 Run required typecheck, patterns, unit tests, shell production build and React Doctor; record actual outcomes in specs/548-aoede-live/tasks.md.
- [ ] T013 Render and inspect Web Canvas/Web Desktop default, microphone-denied, recovery, approval/build and reduced-motion states; artifacts under .amp/in/artifacts/.
- [x] T014 Prepare developer documentation in docs/dev/aoede-live.md and public-docs content for separate FinnaAI/matrix-os-site delivery (publication requires authorization).
- [ ] T015 With explicit paid-call authorization, qualify six-minute duration/expiry, startup ordering, interruption, delayed result and final wallet settlement on production-parity dev:full; record in specs/548-aoede-live/research.md.

## Dependencies and parallel ownership

T001 precedes code integration. T003/T004/T005/T007 can be prepared concurrently with disjoint file ownership; they must not stage, commit or run broad suites. Parent owns contracts, shared gateway composition, delegation and combined validation. T006 gates action/delegation activation. T009 follows T006. T011 follows qualification, not merely compilation. T015 is an explicit external qualification gate, never a silently skipped passing test.

## Graphite Stack Plan

No stack is created during this local implementation: owner explicitly selected one ordinary branch and no new worktrees. Preserve review boundaries for later authorized publication: lifecycle/platform; owner actions/Chat; shell/docs. PR #2040 must land and this branch must be reconciled with upstream main first. If additions exceed 3K or 50 files, split delivery before requesting review; do not flatten oversized publication.

## Verification record

Implementation is a local snapshot, not a release-qualified or published feature. Local paid provider calls and local restarts are authorized; remote deployment, publication and production database writes are not.

- Root typecheck and gateway/platform builds pass. The real-Clerk shell production build passes with the preview opt-in and both auth-bypass flags disabled. The first shell build failed because the local test configuration bypassed ClerkProvider; no product fix was substituted for correct build configuration.
- Pattern scan: zero violations, five existing warnings. React Doctor reports 64 errors/198 warnings in the whole-shell scan, with no Aoede-path diagnostics; this is not a clean audit or a verified baseline comparison.
- Final focused run: nine suites, 95 tests pass, using a dedicated disposable Postgres instance for required SQL semantics. These exercise ownership, funded admission/settlement, recovery, Chat approval/cancellation and persisted Notes/facts; test counts are not live qualification.
- The full repository suite is running and has failures outside the changed feature files. Do not mark T012 complete or claim a green repository run.
- Component previews were rendered and inspected for full-screen idle/active/approval/retry, mobile scrolling and denied-microphone/reduced-motion states. Desktop/Canvas composition and real media behavior remain unqualified; T005/T008/T013 are not complete.
- The local platform was restarted with compiled source bind mounts and wallet-backed Live configuration. The retained VM received the new compiled gateway/contracts and production shell payload, with a temporary 2 GiB memory limit. This is a targeted local update, not a host-bundle rebuild or remote rollout. A loopback SSH reverse tunnel carries gateway speech traffic to the local platform without weakening the production origin validator.
- Real-app qualification is pending gateway startup. The wrapper completed home/skill synchronization and its Node process is running, but port 4000 has not become reachable during the bounded readiness wait. No new paid Live session has been minted. Synthetic microphone input is prepared for an actual provider test, not evidence of a physical microphone or audible playback.
- A running-process CPU sample shows ESM loading and loader synchronization during startup. The gateway cgroup reports no memory-high/max/OOM events. Emulation overhead is a hypothesis, not a proven upstream defect. Upstream tsx issue #809 is about versions after the VM's installed 4.21.0; it does not establish this diagnosis. The unused code-editor service was stopped; stopping the apt upgrade service left children alive, so updater cleanup is not confirmed.
- A read-only focused diagnosis found no new Aoede import cycle and recommended a reversible `tsx/esm` trial. VM Node is 24.18.0; contracts still export source TypeScript, so the loader is required. Only the local runtime wrapper's loader flag changed for this trial, not feature source, auth or owner data. The initial five-minute service readiness budget elapsed during home/skill synchronization and is inconclusive; a separate readiness budget begins after the ESM-only gateway process starts. No listener alone can qualify voice or wallet settlement.
- Legacy Vocal remains until T015 qualifies its replacement. No source-string, styling snapshot or coverage-count checks substitute for that gate.

### Runtime recovery and remaining visual qualification

- `bun run dev:parity:restart` exposed a native-Node contract import failure. The new Aoede export now uses the existing package subpath-import convention. Three existing native-runtime checks failed before the correction; all four checks pass afterward. Root typecheck and the pattern scan passed after the correction.
- The normal restart then passed gateway/shell HTTP readiness and the platform-to-router-to-VM health probe. The earlier loader/emulation hypothesis was not the demonstrated failure.
- An isolated Clerk development-owner browser reached Web Desktop after creating a 12-hour local-only billing override: the retained local database had no entitlement or active override. No Stripe operation or real subscription changed.
- User inspection found clipped overlay controls beneath shell chrome and visible corners in the orb animation. These visual defects remain to be corrected and rechecked in the actual shell. Paid voice, approvals, recovery and final wallet settlement remain unqualified.

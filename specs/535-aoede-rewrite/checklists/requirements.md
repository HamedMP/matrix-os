# Standalone Aoede acceptance checklist

This replaces the old all-green active-Chat specification checklist. Evidence is tracked in ../requirement-evidence.md. A checkbox is not a release qualification claim.

## Definitions (done)

- [x] Owner correction reflected: standalone icon/palette singleton, Chat closed, canonical backend only.
- [x] Scope correction reflected: Web Canvas and browser Web Desktop only; Electron Desktop deferred to a separate follow-up (`electron_desktop` kept as a backward-compatible protocol value, not a target).
- [x] Explicit Start, dismissal, End, generation/action cancellation and continuation/New semantics defined (targeted action cancellation now ships with truthful `cancelled`/`requested`/`already_terminal`/`unknown` outcomes).
- [x] Scope, identity, access loss/deletion and restart behavior defined.
- [x] Action authorization/operation/reconciliation/delegation requirements and fail-closed modes defined.
- [x] Managed speech authority, streaming gap and paid qualification limits defined.
- [x] Two browser surfaces and accessibility required; no Electron host, packaged-app/CSP or Electron evidence requirement remains in this delivery.

## Implementation and deterministic evidence

- [x] Required web implementation uses no parallel tool/task/approval/transcript authority. Aoede is a shell-owned singleton with no `ChatApp` rendering; Electron and product qualification remain explicitly deferred.
- [x] Typed/spoken/queue/retry/steering execution policy proven, including escape attempts. (`chat-voice-session-policy` rewritten and green: untrusted typed requests are normalized to `source:"typed"` with `executionPolicy`/`voiceSessionId` stripped; live voice sessions stamp authoritative policy fields.)
- [x] Exact approval/claim/concurrent dispatch/crash/unknown/reconciliation/cancellation evidence on disposable Postgres. Explicit local admin URL gate: 22 files, 341 passed, one unauthorized live-provider skip; real worker killed after file write and before result persistence, with no redispatch on recovery.
- [x] Singleton/presentation switching and icon/palette/focus callbacks verified in shell DOM tests. Browser fixture renders the real host on two mocked stages with Chat closed: 15 scenarios × 2 stages = 30, not 30 × 2. Full-shell surface integration is not claimed.
- [x] Media/transport/cleanup/permission/device regressions proven. (Reliability suite green; persisted turn mode + device selection/removal, device-loss `input_unavailable`/`output_unavailable` paths, permission timeout and devicechange re-enumeration covered in `tests/ui/` Aoede suites.)
- [x] Fake speech AND fake canonical-provider seams explicitly injected. Consequential composed test exercises real canonical action tools on disposable filesystem, correlated input, exact approval, durable results/export and delivery/ack. Actual Codex is not invoked.
- [x] All required closed-Chat states rendered on mock Canvas/Desktop stages, with representative screenshots inspected. `.amp/in/artifacts/aoede/run-status.json` records 30 passes; keyboard/focus, reduced-motion CSS and card interactions are executed checks. Images are isolated-host evidence, not real-device or full-shell evidence.
- [x] Committed implementation gates recorded: 2,370 affected tests, 341 PostgreSQL tests, package/repository typechecks, patterns, React Doctor, shell build and diff checks. The evidence ledger requires repeating these gates after its commit, before handoff, with `*-final-head.log` artifacts.
- [x] No unresolved local implementation requirements concealed as release gates.
- [x] Simulator registration is impossible in production; `dev:voice:simulator` naming reflects the development-only simulator path.
- [x] Managed STT + streaming-TTS readiness probe is wired; configured-unready, timeout and unknown fail closed. (`speech/managed-readiness.ts` composed into `server.ts` for both voice routes and Aoede bootstrap; `synthesisSource` prevents false failure of managed adapters using external/dev synthesis.)
- [x] Standalone Aoede fixture runs with Chat closed on mocked Canvas/Desktop stages.
- [x] Open-app navigation, file artifact, outcome_unknown and reconciliation are projected and handled end to end. (`detail.operations` contract + `projection.ts` + `AoedeCanonicalCards` + `openNavigation`/`openResult`.)
- [x] Bounded clarification/input works on the required constrained-Codex path; unsupported additional provider-native input remains visibly fail-closed.
- [x] Targeted `action.cancel`, persisted mode and device selection/removal are wired and covered. (HTTP route + authority CAS-retry + `action.cancel_result` WS ack + `unknown` outcome + card-level truthful rendering + fixture coverage incl. forced-`unknown`.)
- [x] Voice API prose and drift tests match common frame identity, resume/correction and generation/action cancellation schemas. (`contracts/voice-session-api.md` documents `operationId`, `action.cancel`/`action.cancel_result`, and all five outcomes; contract tests enforce the enum.)
- [x] Minimum delivery matrix is complete: standalone provider/model selection and recovery; constrained Codex conversation + five bounded tools; approval/clarification; durable activity/navigation/artifact/result/reconciliation/history; generation cancellation; and truthful targeted action cancellation.

## Not authorized / deferred

- [ ] Separately authorized real speech/Codex/device/parity/account/latency/usability release qualification completed.
- [ ] Separately authorized public docs PR and review/release lifecycle completed.
- [ ] Deferred follow-up (not this checklist): Electron Desktop host — nonmodal/native-view-safe geometry, icon/palette/runtime fencing, packaged-app Origin/CSP policy and its own fixture evidence.

# Standalone Aoede acceptance checklist

This replaces the old all-green active-Chat specification checklist. Evidence is tracked in ../requirement-evidence.md. A checkbox is not a release qualification claim.

## Definitions (done)

- [x] Owner correction reflected: standalone icon/palette singleton, Chat closed, canonical backend only.
- [x] Scope correction reflected: Web Canvas and browser Web Desktop only; Electron Desktop deferred to a separate follow-up (`electron_desktop` kept as a backward-compatible protocol value, not a target).
- [x] Explicit Start, dismissal, End, generation/action cancellation and continuation/New semantics defined (targeted action cancellation remains unimplemented).
- [x] Scope, identity, access loss/deletion and restart behavior defined.
- [x] Action authorization/operation/reconciliation/delegation requirements and fail-closed modes defined.
- [x] Managed speech authority, streaming gap and paid qualification limits defined.
- [x] Two browser surfaces and accessibility required; no Electron host, packaged-app/CSP or Electron evidence requirement remains in this delivery.

## Implementation and deterministic evidence

- [ ] All AO requirements locally implemented with no parallel tool/task/approval/transcript authority. (Historical focused observations exist in the matrix; no final-HEAD B evidence or full-suite run.)
- [ ] Typed/spoken/queue/retry/steering execution policy proven, including escape attempts. (Historical approval-equality and Codex-isolation observations exist; queue/retry/steer coverage and final B are incomplete.)
- [ ] Exact approval/claim/concurrent dispatch/crash/unknown/reconciliation/cancellation evidence on disposable Postgres. (Historical delivery observation only; the old action-fixture JSONB defect is fixed in source, but the action suite is omitted from the current script and needs a current rerun.)
- [ ] Singleton and closed-Chat workspace integration proven on both browser surfaces. (Historical injected-seam shell observations exist; no final B or inspected manual run.)
- [ ] Media/transport/cleanup/permission/device regressions proven. (Historical core reliability observations exist; persisted mode/device selection, device removal, permission timeout and final B remain incomplete.)
- [ ] Fake speech AND fake model/action composition established before any fixture run. (The composed test uses simulator media/fake provider but currently times out; the visual fixture is still Chat-attached legacy UI.)
- [ ] All required closed-Chat states rendered and screenshots inspected on Web Canvas and Web Desktop; keyboard/focus/live-region/reduced-motion/contrast/zoom tested. (Historical rendered-state unit observations exist; inspected screenshots, manual accessibility and final B are not recorded.)
- [ ] Affected focused/broader tests, package/repository typechecks, pattern/anti-slop, React Doctor, shell build, PG gates and diff checks recorded on final HEAD. (Checkpoint typecheck/pattern/focused tests are recorded; composed path, full shell build, PG action gate and visual evidence remain outstanding.)
- [ ] No unresolved local implementation requirements concealed as release gates.
- [ ] Simulator registration is impossible in production; `dev:voice:integration` is renamed/redefined truthfully.
- [ ] Managed STT + streaming-TTS readiness probe is wired; configured-unready, timeout and unknown fail closed.
- [ ] Standalone Aoede fixture runs with Chat closed on Web Canvas and Web Desktop.
- [ ] Open-app navigation, file artifact, outcome_unknown and reconciliation are projected and handled end to end.
- [ ] Bounded clarification/input works on the required constrained-Codex path; unsupported additional provider-native input remains visibly fail-closed.
- [ ] Targeted `action.cancel`, persisted mode and device selection/removal are wired and covered.
- [ ] Voice API prose and drift tests match common frame identity, resume/correction and generation/action cancellation schemas.
- [ ] Minimum delivery matrix is complete: standalone provider/model selection and recovery; constrained Codex conversation + five bounded tools; approval/clarification; durable activity/navigation/artifact/result/reconciliation/history; generation cancellation; and truthful targeted action cancellation.

## Not authorized / deferred

- [ ] Separately authorized real speech/Codex/device/parity/account/latency/usability release qualification completed.
- [ ] Separately authorized public docs PR and review/release lifecycle completed.
- [ ] Deferred follow-up (not this checklist): Electron Desktop host — nonmodal/native-view-safe geometry, icon/palette/runtime fencing, packaged-app Origin/CSP policy and its own fixture evidence.

# Standalone Aoede acceptance checklist

This replaces the old all-green active-Chat specification checklist. Evidence is tracked in ../requirement-evidence.md. A checkbox is not a release qualification claim.

## Definitions (done)

- [x] Owner correction reflected: standalone icon/palette singleton, Chat closed, canonical backend only.
- [x] Scope correction reflected: Web Canvas and browser Web Desktop only; Electron Desktop deferred to a separate follow-up (`electron_desktop` kept as a backward-compatible protocol value, not a target).
- [x] Explicit Start, dismissal, End, generation/action cancellation and continuation/New semantics defined.
- [x] Scope, identity, access loss/deletion and restart behavior defined.
- [x] Action authorization/operation/reconciliation/delegation requirements and fail-closed modes defined.
- [x] Managed speech authority, streaming gap and paid qualification limits defined.
- [x] Two browser surfaces and accessibility required; no Electron host, packaged-app/CSP or Electron evidence requirement remains in this delivery.

## Implementation and deterministic evidence (this pass)

- [ ] All AO requirements locally implemented with no parallel tool/task/approval/transcript authority. (Partially evidenced: focused suites pass — see matrix; no full-suite run.)
- [ ] Typed/spoken/queue/retry/steering execution policy proven, including escape attempts. (Typed+spoken approval equality passes in chat-action-integration; codex native-config isolation suites pass; queue/retry/steer escape coverage is partial.)
- [ ] Exact approval/claim/concurrent dispatch/crash/unknown/reconciliation/cancellation evidence on disposable Postgres. (BLOCKED: chat-action-postgres beforeAll fails on real PostgreSQL 18 — `invalid input syntax for type json` on the JSONB `parts` fixture insert; chat-voice-delivery-postgres 4/4 pass on the same disposable DB.)
- [ ] Singleton and closed-Chat workspace integration proven on both browser surfaces. (Shell host/lib/desktop-icon suites pass with injected seams; no inspected manual run recorded.)
- [ ] Media/transport/cleanup/permission/device regressions proven. (voice-session-reliability 15/15 pass incl. bounded DELETE retry parking and transport-loss playback stop.)
- [ ] Fake speech AND fake model/action composition established before any fixture run. (UI/shell fixtures inject fake api/voiceFactory seams; a single composed fake-speech + fake-canonical-model end-to-end fixture is not yet evidenced.)
- [ ] All required closed-Chat states rendered and screenshots inspected on Web Canvas and Web Desktop; keyboard/focus/live-region/reduced-motion/contrast/zoom tested. (Rendered-state unit tests pass; inspected screenshots and a manual accessibility pass are not yet recorded.)
- [ ] Affected focused/broader tests, package typechecks, pattern/anti-slop, React Doctor, shell build, PG gate and diff checks recorded. (Focused vitest files recorded in the matrix; typecheck/pattern/React Doctor/shell-build/diff-check runs outstanding.)
- [ ] No unresolved local implementation requirements concealed as release gates.

## Not authorized / deferred

- [ ] Separately authorized real speech/Codex/device/parity/account/latency/usability release qualification completed.
- [ ] Separately authorized public docs PR and review/release lifecycle completed.
- [ ] Deferred follow-up (not this checklist): Electron Desktop host — nonmodal/native-view-safe geometry, icon/palette/runtime fencing, packaged-app Origin/CSP policy and its own fixture evidence.

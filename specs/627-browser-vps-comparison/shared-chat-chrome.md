# Shared Chrome for Chat harnesses

Status: active. Owner approved Pi, OpenClaw and Hermes integration and invoice collection validation on 2026-10-14.

## Goal
Chat operates the same visible owner Chrome as Browser. One Matrix-owned bounded controller serializes actions, drains in-flight work before human takeover, blocks queued/stale actions while paused, and resumes only after owner action and fresh observation. Chrome/profile stays running on cancellation, reconnect and detach. Invoice collection produces verified original artifacts and a provenance manifest from a synthetic fixture before real services are used.

## U1 — Shared browser broker and artifacts (orchestrator)
- Goal: fixed owner-local CDP attachment with canonical run binding, gated actions, pause/takeover/resume/cancel and verified invoice downloads.
- Files: new packages/gateway/src/shared-browser/**; packages/gateway/src/server*.ts composition only; packages/contracts/src/shared-browser.ts/export; tests/gateway/shared-browser*; synthetic fixture under scripts/spikes/browser-vps/invoices/**.
- Approach: test first; authenticate owner controls separately from run-bound execution; validate bounded input, prohibit raw endpoints/credential extraction, serialize operations with generation guards; original downloads go to owner-contained files with hash/source/document metadata. Current run state is bounded/ephemeral; no alternative database.
- Test scenarios: two competing runs, takeover during action, late queued action, pause/resume with fresh snapshot, expired/cancelled binding, tab navigation/closure, timeout and failed download, deduplication/conflicting evidence.
- Verification: full real-object chain, typecheck/build, scoped test VPS and same Chrome process.

## U2 — Pi / OpenClaw / Hermes wiring
- Goal: each Chat harness reaches U1 and cannot accidentally use raw shared CDP around the gate.
- Files: focused helpers and adapters in packages/gateway/src/chat and coding-agents; bot tool contract/registry as required; matching tests. Do not edit gateway server composition or U1 files without coordination.
- Approach: first inspect actual runtime tool registration, then choose version-verified tool bridge; hook run cancellation/cleanup into broker binding revocation. Root coordinates shared interface and wiring.
- Execution note: tests first after real runtime assumptions are verified.
- Test scenarios: identical visible Chrome for all three; actual native tool invocation; unavailable bridge fails closed; run ID/owner/cancel validation; policy gate rechecked at action time.
- Verification: adapter integration tests and bounded live model-driven synthetic runs for all three harnesses.

## U3 — Browser takeover UI
- Goal: Browser and Cloud desktop show agent/human/paused states and owner Take over/Pause/Resume actions consistently.
- Files: packages/ui/src/browser/**; tests/ui/browser*; native exact action allowlist helper only if coordinated.
- Approach: shared component/controller, no duplicate renderer policy; bounded polling/status, prevent clicks during transitions and give reliable error/retry state. Preserve responsive sizing and viewer reconnect.
- Execution note: tests first after U1 contract is fixed.
- Test scenarios: action-in-flight drain, failed takeover keeps input unavailable, pause blocks actions, resumed viewer state, inactive surface and actual reconnect.
- Verification: shared tests and Web Canvas, Web Desktop, Electron Desktop live evidence; update Figma.

## U4 — Existing CI / Greptile fixes
- Goal: fix current PR check failures and existing 4/5 findings; final head green CI and Greptile 5/5.
- Files: existing analytics category helper/tests, comparison runner/Chrome close/hosted diagnostic catches, plus files identified by CI logs outside U1/U2/U3 ownership; coordinate any collision before edit.
- Approach: classify actual CI logs, reproduce relevant failures, add failing regressions first for behavior changes; safe fixed failure categories without page/credential logs. Root stages/commits/pushes and requests final review.
- Test scenarios: Browser launch/focus/minimize/close category consistency; safe errors/timeouts; current CI failing tests and typecheck.
- Verification: targeted green checks, resolve actual review threads, current-head review/CI; add ready-for-ci when Greptile reaches 5/5.

## Delivery / auth
All owner controls use existing personal owner authentication and strict body limits. Agent calls use a gateway-registered exact owner/chat/run capability, checked before every action and revoked on run completion/cancellation. No raw CDP port is exposed publicly, forwarded to harnesses or accepted from page content. Inputs/results/queues/maps/artifacts/timeouts are bounded. Human auth and password-manager contents are excluded from evidence.

Final delivery updates implementation PR #2526, public site docs PR #234, Figma screenshots and #2571. No primary runtime or fleet rollout. Do not merge without required CI/current-head Greptile 5/5.

Parallel safety: U1 root owns broker/composition; U2 owns harness helpers/adapters; U3 shared browser UI; U4 previous comparison diagnostics and CI-only fixes. Workers do not stage/commit/push or revert other workers. Shared interface changes require coordination; all code remains in the existing manual worktree.

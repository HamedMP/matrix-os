# Reliable Native Command Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan after its review and implementation authorization. Steps use checkbox syntax for tracking.

**Goal:** Recover one lost Native control-poll response without losing infer/Cancel or dispatching model work twice, while preserving v1 and source/funding/termination protection.

**Architecture:** A separately negotiated v2 poll retains a bounded session-scoped command ledger until a validated cumulative receipt ACK. Native handles commands once and may repeat one same-session poll. No inference/reply replay and no durable queue.

**Tech Stack:** TypeScript, Zod 4, Hono, existing PostgreSQL test helpers, Electron Native peer, Vitest; pnpm/bun only.

**Spec:** [Reviewed protocol proposal](poll-delivery-v2-design.md). Source baseline `2ae9cfecef710ed59efe475435240c46cae5165d`, checked 2026-10-22. Implementation status and qualified exceptions are recorded below; this plan alone is not a runtime acceptance claim.

## Global Constraints

- The user authorized this reviewed paired implementation and offline verification on 2026-10-23. Paired Preview update/model/GUI testing is a later separate authorization boundary. The earlier frozen design-only report remains historical.
- Work only in the existing manual `fix/eng344-t3-first-pass` worktree; retain unrelated commits. Do not modify Main/shared Platform, permissions, funds, credentials or other QA apps. No global kill/reset.
- Read constitution/Trellis task context before each phase. Production baseline and task evidence stay pinned; no repeated 225/3123 suites without a new relevant change.
- Keep v1 DTO/dequeue and narrow retry behavior; do not make the current v1 design counterexamples pass by silently changing v1.
- No inference/reply POST retry, automatic re-enrollment, new database persistence, TLS verification exception, raw prompt/reply/token logging or external model requests in offline phases.
- Every changed behavior starts with a meaningful failing test on actual production code, then minimum implementation. Keep focused modules below 500 lines; registry starts at 416 and Native peer at 305.

## Review Focus

Review protocol negotiation, ACK mutation order, retained Cancel, bounded HTTP tails, same-ACK coalescing, source/session/attempt fencing, exact memory/TTL accounting and rollback. The proposed v2-only recovery of `ERR_SSL_PROTOCOL_ERROR` requires explicit acceptance of the design; v1 and certificate/auth failures remain fail-closed.

---

## Task 1: Contract and route admission

**Files:** create `packages/contracts/src/chatgpt-plan-poll-delivery.ts`; add its `#chatgpt-plan-poll-delivery` import mapping in `packages/contracts/package.json` and a re-export in `packages/contracts/src/index.ts` (no logic in the large index); create `tests/contracts/chatgpt-plan-poll-delivery.test.ts`; update `packages/gateway/src/bots/chatgpt-plan-peer-routes.ts`; create `tests/gateway/bots/chatgpt-plan-poll-delivery-routes.test.ts`.

- [ ] Confirm actual test/export conventions (`rg --files tests packages/contracts`) before creating exact paths. No dependencies.
- [ ] Write REDs for strict capability/request/response schemas, uint48/exhaustion, contiguous batch/session identity and unchanged v1 rejection of ACK fields. Verify assertion/setup failures separately.
- [ ] Add the three proposed schemas/types only; reuse existing infer/Cancel schema and byte constants. Enforce bytes at consumer/route boundaries, not only string length.
- [ ] Write route REDs for verified Native bearer/owner, cookie/dev-default denial, missing registry 503, no-store, wrong session/mode/ACK, pre-buffer 512-byte body limit and generic errors. Pass request abort signal into the poll operation.
- [ ] Add capabilities and poll-v2 routes without changing existing proof/reply routes. Register specific 512-byte bodyLimit before wildcard and skip these paths in the generic limiter. Read at most 513 actual bytes, cancel/reject oversized input before JSON/Zod; test missing/false declared length locally without claiming a production framing bypass. Capabilities lookup has no lease touch/mode lock. Do not add version discovery to enable fallback; unsupported unrecognized Host fails closed.
- [ ] Run `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism tests/contracts/chatgpt-plan-poll-delivery.test.ts tests/gateway/bots/chatgpt-plan-poll-delivery-routes.test.ts`; observe real exit codes, no external calls. Review schema/export wiring and actual body-limit order before proceeding.

## Task 2: Bounded Host delivery ledger

**Files:** create `packages/gateway/src/bots/chatgpt-plan-poll-delivery.ts`; update `packages/gateway/src/bots/chatgpt-plan-peers.ts`; create `tests/gateway/bots/chatgpt-plan-poll-delivery.test.ts`; retain existing peer tests.

**Proposed focused helper interface (not implemented):** per-session `mode`, `lastAcked`, `highestSent`; `admitInfer`, `cancel`, `pollV2(ackThrough, signal)`, `close`; immutable published commands, fixed expiry, encoded-byte accounting. Keep owner/session lookup and captured-peer drop in registry, not a generic reusable queue. Exact type names may follow local style without changing specified behavior.

- [ ] Move the two existing task RED scenarios to explicitly negotiated v2 tests on actual registry. Keep their original-command ID/body assertions. Retain the v1 destructive-dequeue GREEN control.
- [ ] Write REDs for ACK loss/repeat/lower/future, mode race, wrong session, canceled unsent infer, sent infer + retained Cancel, completed-but-unACKed infer, count/bytes/reserve/sequence overflow, and fixed TTL checked before ACK. Do not invent a fake helper ledger in tests.
- [ ] Test ACK immediately before an entry's expiry followed by its old deadline: removed entry cannot close that session or a replacement; remaining unACKed entries retain original deadlines. Use one earliest-expiry timer plus access checks and captured peer/entry fences.
- [ ] Extract the smallest delivery helper before adding registry behavior. Split lookup/touch and implement synchronous validate->ACK/mode transition, captured-peer-only closure and cleanup. Preserve all inference/idle/funding timers.
- [ ] Add long-poll REDs: max two cumulative same-ACK waiters before publication; one original 10-second timer; publication retires pointer; higher ACK works while old tail finishes; empty response followed by same-ACK new Cancel; third/slow HTTP waiter bounded globally; stale finally cannot clear new poll/session.
- [ ] Implement bounded waiters with request abort support. For v2 route emission, reuse existing `hono/streaming` helper with unchanged JSON wire, bounded writes and a fixed 15-second publication-to-emission deadline. At most two application-owned waiter/emission slots per peer across old published tails and a new logical poll; release each slot only in its writer completion/abort finally. Bind request abort/response cancel explicitly; helper write resolution does not prove success. An individual emission abort/failure/deadline releases only that emitter, preserving session/ledger/original TTL. Joining does not reset the logical deadline. Freeze batches once; do not cache empty batches by ACK.
- [ ] Add REDs on actual Hono/Node response lifecycle: published original response abort then same-ID recovery succeeds; old-emitter finally cannot close a new session; slow-reader third admission rejected; one emitter deadline frees its own slot without pruning commands or renewing TTL. Do not equate `c.json()` return with network completion or claim OS socket-buffer bounds.
- [ ] Make helper/admission tests GREEN, then run existing Host peer/route tests relevant to the modified paths. Test full JSON envelope accounting with escaped text and image bodies; track ledger bodies + at most two shared frozen encodings + <=64 KiB emission chunks, without equating encoded bytes to heap size. Check all shutdown timers/listeners/drains. Record actual exits and skipped counts.

## Task 3: Native receipt and one recovery

**Files:** create `desktop/src/main/chatgpt-plan/poll-delivery.ts` if extraction keeps responsibilities clear; update `desktop/src/main/chatgpt-plan/peer.ts`; create `tests/desktop/chatgpt-plan-poll-delivery.test.ts` alongside existing peer/recovery tests. Do not edit inference workers or proxy/security settings.

- [ ] Write REDs for capabilities bound to current session, v1/new and old/new compatibility, naked404/HTML/auth/TLS/schema failures not falling back, v2-attempt flag set before fetch, and no same-session downgrade after rollback.
- [ ] Implement strict negotiation. If no existing trusted installed-Host compatibility mapping is demonstrated, omit automatic old-Host fallback and keep known v1 client artifacts as the compatibility path. Do not guess from display/version strings.
- [ ] Write REDs showing `poll-v2` gets 15 seconds and accepts a valid >2 MiB response within existing poll cap; separately check the bounded reader's exact-cap and one-byte-over behavior. Refactor `post()` poll-path checks so both poll versions share existing poll deadline and 46,918,320-byte cap; other POST/reply budgets stay unchanged.
- [ ] Write REDs for complete response validation before effects, contiguous handled cursor, exact ID/expiry/high-water, at-most-once inference dispatch, same-batch Cancel suppression, safe rejection ACK timing, Cancel idempotency and no success after source/Stop.
- [ ] Explicitly test `[infer A(seq1), infer B(seq2), Cancel B]`: A dispatches once, B zero times. Cancel pre-scan cannot advance infer high-water before the ordered pass.
- [ ] Implement command receipt without waiting for model completion, preserving existing calls/pending cap and per-inference timers. Pre-scan only the bounded batch; no persistent unbounded Cancel set.
- [ ] Write REDs for one v2 recovery during initial delivery and during active stream, same ACK/session, failed-attempt abort/fencing, 15-second fixed extra deadline, second failure closure, session/source changes, certificate/auth/unknown error closure, no model/reply retry. Keep all v1 recovery controls GREEN.
- [ ] Implement only the reviewed error predicate; do not treat every network/TLS/reset/timeout as retryable. No strict-HTTPS changes. Record the actual effective predicate in the PR.
- [ ] Test hard-rejection precedence across error/cause fields: generic SSL protocol code with certificate-expiry cause is rejected; abort/source/auth/trust wins before positive allowlist matching. No raw error text or credentials in diagnostics.
- [ ] Run new Native tests and affected existing peer/stream/source tests, then `pnpm exec tsc -p desktop/tsconfig.node.json --noEmit`. Full configured project validation, if warranted by the final diff, uses `bun run typecheck:run`; report the compiler and actual scope. Report pre-existing failures separately; the 63 known Native Mobile errors are not fixed by this work.

## Task 4: Actual-module offline qualification and review

**Files:** create `tests/gateway/bots/chatgpt-plan-poll-delivery-integration.test.ts`; update `specs/633-agent-waiting-policy/spec.md`, `docs/dev/chat-run-limits.md` and `docs/dev/bot-inference-limits.md` only where final implemented protocol behavior belongs.

- [ ] Wire actual Native peer -> actual Hono route/auth/body boundary -> actual registry -> synthetic local stream -> actual reply ACK with existing local PostgreSQL helper. Fault seams discard actual responses after Host mutation; no fabricated queue/replay implementation.
- [ ] Cover request loss, infer response loss, Cancel response loss, ACK request loss and ACK response loss separately. Assert unchanged original command identity, one inference dispatch, eventual Cancel/no new output, exact ACK cursor and cleanup. Test old Native/new Host and new Native/unrecognized old Host outcomes explicitly.
- [ ] Include lifetime/funding/authority barriers: poll/ACK/replay never increments model progress or extends original expiry; source revocation/Stop wins; replies retain EOF authority checks. Do not claim these from unit ledger tests alone.
- [ ] Run affected contracts/Host/Native tests and configured type checks once after final code changes. Broaden only for changed dependencies, failures or new concerns. Record failures/skips and coverage gaps; do not label entire project green.
- [ ] Independent code/security review against spec, especially long-poll tails and source fencing; fix findings with RED->GREEN. Keep protocol implementation diff separate from unrelated PR/Main conflicts.
- [ ] Update Draft PR #2794 only after implementation authorization, with exact commits/test evidence and unpassed live cases. No merge/formal Greptile or release CI before the user's agreed review gate.

## Task 5: Paired Preview acceptance — gated, not executed by this plan

- [ ] Obtain explicit authorization for paired existing Private Preview Host + own Native artifact update after the protocol review. Coordinate GUI ownership, retain other QA instances/profiles, and check no active/unknown test writes before updating.
- [ ] Record exact Host source/bundle/running version, Native source/asar and session mode. Deploy Host first with v1 support, then own matching Native. Old session ends on Host restart; new tasks use a new session.
- [ ] In full-screen **Electron Desktop**, capture short response, stream above previous total-payload boundary, Stop and a fresh turn, then controlled poll-loss recovery with one original inference. Screenshots must match visible UI and canonical run/log evidence.
- [ ] Run true continuously working 10/30-minute cases only after short/stream/recovery pass. Collect elapsed/run outcome, transport diagnostics and screenshots. Human approval waiting and simulated clocks are separate cases, never substituted for continuous work.
- [ ] Check rollback Native-first with new session; Host rollback closes old v2 sessions without resubmission. Avoid destructive live rollback unless separately approved; prove offline first.
- [ ] Create separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/` for the final shipped behavior, compatibility, bounded retry and Stop. Public-safe only; no private runtime/incident data.
- [ ] Final limitations/results table separates implemented, offline-tested, real Electron-tested and unknown across providers, attachments, output, approval and funding. No completed claim while the required long-run acceptance remains unpassed.

## Implementation execution record — 2026-10-23 Asia/Shanghai

- Tasks 1–4 are implemented locally starting at `7caa045ef830815c659517e8edad9687c70cea19`; final review and post-review verification are retained in the task evidence. The original detailed checkboxes remain the planned validation inventory, not a claim that every proposed experiment was executed.
- Contract, authenticated actual-byte admission, retained delivery/Cancel, ACK validation, bounded emitters, Native negotiation/receipt/recovery, four actual-module synthetic paths and one real local HTTP response-loss path were exercised. Existing v1 controls remain passing.
- Scope rulings: sequence exhaustion is guarded in production and reviewed statically rather than attempting trillions of messages. Shared bounded-reader exact/one-over tests use the 512-byte capability budget, plus a separate >2 MiB valid poll and 12-second wait; no 46.9 MiB stress test. Request loss and ACK-request loss are covered by admission/ledger controls, not claimed as additional actual-module end-to-end fault cases.
- One fresh final source review found a P2: a queued `subarray` retained the entire frozen response encoding beyond emitter release. A real Hono response backing-buffer RED preceded the bounded chunk-copy fix. The separate pre-enqueue cancellation race was classified as minor baseline hardening; two REDs precede the post-revalidation abort check. Neither finding establishes the earlier real TLS failure cause.
- No inference/reply replay, TLS exception, source/permission/funding policy change, dependency install, Preview update, GUI operation or real model request occurred in this increment.
- Task 5 remains **unexecuted**: paired Host/Electron build and provenance, private acceptance, real continuously busy 10/30-minute workloads and full-screen Electron screenshots are release gates. The separate public-site documentation PR remains a release deliverable; an offline public-safe draft is prepared with the implementation evidence.

## Design-phase evidence already available

Actual baseline production modules, no code edits: two expected RED assertion failures (exit 1, 3.944s) and four final GREEN safety controls (exit 0, 3.692s), each under a 20-second external timeout. An initial control fixture scheduling error and its unchanged-assertion correction are retained separately. Those design-phase results remain historical; see the later implementation execution record above. They do not qualify Task 5.

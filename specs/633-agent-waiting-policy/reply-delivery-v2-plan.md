# Recover one lost Native reply ACK without repeating inference

Status: protocol reviewed; review constraints incorporated before implementation.
Base: `9cfe0bf0f14f4ab6338015d4ec7e5ad0662c53ec` (2026-10-23).

## Problem and evidence

An admitted owner-subscription turn can still fail when a streamed reply POST loses its response. The existing command poll-v2 ledger covers infer/Cancel delivery; it does not make reply chunks or final ACKs replayable. Current Host streaming advances its sequence on acceptance (ACK waits for consumption) and removes the pending request at end. Identical resubmissions then conflict. The Native implementation ends inference on that transport failure. A successful origin request status cannot establish that the client received its ACK.

Offline probes against the actual Host and Native modules reproduce three missing behaviors: duplicate consumed chunk ACK, duplicate final ACK, and a lost reply ACK ending a v2 command session. Altered content and late end after Cancel remain correctly rejected. No real inference is used in those probes.

This increment changes transport delivery only. It does not increase inference, attachment, context, credentials, financial, time or tool budgets. It changes no central Relay/Platform code. Do not relax TLS/certificate validation, blindly replay model requests or restart an uncertain tool/write.

## Minimal negotiated extension

Keep the existing authenticated `/api/chatgpt-plan/device/capabilities` endpoint, session body and reply body. A new Native client opts in with the exact query `includeReplyDeliveryV2=true`. An old client omits it and receives its original strict response unchanged. A new Host adds `replyDeliveryVersion: 2` only for that opt-in. A new Native accepts the optional flag; absence means no reply retransmission, even though poll-v2 is supported. Do not infer reply support from command delivery version or build SHA.

Validate the opt-in at the route boundary. All endpoints retain verified runtime bearer, exact owner and signed current peer session. Availability/auth/source failures never imply fallback permission. The new flag enables receipt handling only in that same peer session, before the first poll/publication (already queued, unpolled inference is allowed); it cannot replace another device or widen a grant.

| Changed endpoint | Authentication / scope | Public |
| --- | --- | --- |
| POST `/api/chatgpt-plan/device/capabilities` | Verified runtime bearer, exact owner and current signed peer session; strict opt-in | No |
| POST `/api/chatgpt-plan/device/reply` | Verified runtime bearer/owner before input buffering; exact current peer session/request and strict reply schema before effects | No |

## Host receipt semantics

- Retain the most recent chunk sequence, SHA-256 of its exact UTF-8 body, and its existing consumption-ACK promise in each active stream (at most four). This adds no second retained receipt payload; normal bounded JSON input buffers remain transient. Accept an identical duplicate only for the current last sequence, with unchanged digest and a live un-aborted pending request. Return that same ACK/promise without enqueueing bytes or advancing the sequence twice.
- Reserve one of eight global HTTP emission slots after cheap verified bearer/owner authorization and before `bodyLimit`. Start a fixed 10-second deadline at reservation, covering body read, ACK wait and response emission; cancel bounded input reads on timeout/request abort. Enforce at most two concurrent ACK waiters per exact session/request after strict parsing. Also cap cumulative HTTP ACK admissions at two per chunk (initial plus one retransmission), counted before attaching Promise reactions, never decremented on timeout/abort and reset only by a new valid ordered chunk. This bounds abandoned Promise reactions under sequential disconnect churn; a third attempt fails closed. Hold slots through response completion/abort, release in all error paths, and discard parsed bodies after digest comparison. HTTP abort/timeout detaches only its waiter; it does not discard accepted bytes, fail the stream or renew idle.
- Duplicates awaiting downstream consumption share the same promise. A failed/aborted consumption rejects all waiters. Duplicate receipt reads do not extend stream idle or revive work. Changed content, older/future sequence, or already failed/ended stream chunks remain conflicts.
- End remains ordered and requires no buffered chunk. For negotiated sessions retain the successful final ACK after pending removal, so the same end sequence can receive the same ACK again. No chunk replay after end, and no end receipt for cancellation/failure before end acceptance. Normal forwarder EOF cleanup aborts its old inference signal: final receipt replay must not depend on that signal remaining live. A receipt attests only that ordered transport end was accepted, under the current session and fixed TTL, not canonical run success.
- Keep at most 32 final receipts per peer with FIFO eviction and a 120-second TTL, using the existing request-lifetime constant. Sweep before lookup/admission; shutdown/drop clears all receipts with the peer. No persistence, new DB table or body retention. Evicted/missing receipts fail closed rather than guessing.
- Owner/device/session replacement, Cancel, expiry, revoke and shutdown keep their existing authority barriers. A final ACK tombstone acknowledges only transport completion; it cannot revalidate credentials or alter a canonical run terminal state.

## Native retransmission semantics

Only when the same signed Host session advertised reply version 2, retain the one current immutable parsed reply and try its exact bytes/sequence once more after a bounded 100ms abortable delay. Wait for its matching session/request/sequence ACK before advancing. Revalidate current source and abort before delay, before each POST and after its ACK. Each POST keeps its existing 10s deadline; do not retry inference, account refresh, challenge, connect, disconnect, arbitrary errors or writes.

Use the existing narrowly reviewed transport classification: explicit safe preconnect errors or `ERR_SSL_PROTOCOL_ERROR`, with unknown/certificate/auth/permission/blocked causes vetoing recovery. Apply the same bounded cause check to reply failures, not just poll failures. Poll's existing one consecutive retry budget remains unchanged. Two failed reply attempts still fail closed. 409 keeps its existing settled/Cancelled interpretation and never starts inference again.

An exact own-POST deadline may spend that same retry budget. Capture the original request-deadline signal and only attach the allowed pre-header/body-read phase when the original caught exception is exactly its reason, it has expired, and the caller signal is not aborted. A coincident foreign error must not borrow the merged timeout reason. The classifier requires the matching peer stage/category/phase and no transport/certificate/unknown code. Parent idle/lifetime timeouts, cancellation, stale source, unknown timeouts and post-read binding failures remain ineligible. No new wire field or capability is introduced. Reply retry still requires explicit reply-v2 negotiation; v2 polls use their existing single-consecutive-failure budget. Legacy polling and unnegotiated replies gain no timeout retry. Each reply/poll attempt remains 10s/15s. Two poll attempts can reach the unchanged 30s command TTL, which remains authoritative rather than renewing on retry.

Keep EOF/final authority validation, 64KiB chunks, the shared unfinished-SSE/held-terminal 1MiB bound, four concurrent inferences, control ledger and Cancel priority unchanged. No unbounded queue, indefinite grace period, new model call or cross-session replay is introduced.

## Compatibility and rollout

| Host | Native | Behavior |
| --- | --- | --- |
| old | old | Original behavior |
| new | old | Original strict capability response; no opt-in receipt semantics |
| old | new | Old capability response accepted; no reply retry |
| new | new | Negotiated exact reply receipt/retry behavior |

Deploy to the existing Private Preview and matching isolated Electron Desktop only after review and offline checks. Host first is safe. Do not hot-swap an active peer: wait for confirmed idle. A Host rollback loses volatile sessions and fails affected work closed; never replay it across a new session. Normal release still requires matching readers, Main conflict resolution, user review and formal review/CI gates. No production or central Relay deployment is included.

## Tests and acceptance

Review: readonly protocol review found one P1 (unbounded duplicate HTTP waiters), addressed by admission/deadline/emission and cumulative per-chunk admission caps above, and two P2 corrections (sequence wording and explicit negotiation in fixtures). Follow-up review caught and RED/GREEN covered cumulative detached Promise reactions, actual-byte overflow status and inference-queued-before-negotiation races. Existing probes without opt-in remain legacy no-retry/no-receipt controls, not desired-GREEN tests.

1. Actual Host: consumed chunk replay ACKs once without duplicated text; in-flight duplicate shares consumption; changed body/sequence rejects; final ACK replay after removal; cap/TTL/shutdown cleanup; full forwarder EOF cleanup followed by final ACK replay; eight global slots before buffering, two waiters per stream, timeout/abort preserving accepted chunk.
2. Actual Native with a v2 command session: lost chunk/end ACK before/after server acceptance recovers once with one inference only. Legacy Host never retries. A second failure, trust/unknown cause, binding change and Cancel abort recovery; no late end can succeed.
3. Integration of actual Native and Host/route: drop one ACK, preserve exact text/order and final barrier. Cancel during the delay/backpressure remains authoritative. Old/new combinations retain their exact capability schema.
4. Only then rebuild/register a new exact-source private Host bundle and matching QA Electron. Reuse the existing Preview/profile; no credential copying or new VM.
5. Fresh English real-work turns: short, stream/Stop, next turn, actual busy 10/30 minutes, >96KiB saved tail/complete Copy/reopen. New evidence must name the exact source. An SSL failure remains an actual failure if bounded recovery is exhausted; do not call it a timeout or successful run.
6. Update runtime support docs and prepare the separate public-site documentation PR as a release deliverable. No new paid resources or funding/permission changes.


### 2026-10-23 Native-only 502 recovery follow-up

Paired QA exposed an intermediate gateway HTTP 502 closing the negotiated peer while a reply recovery was still eligible. A roughly 30-minute failure is not by itself proof of an aggregate run deadline. The follow-up uses the same existing one-retry budget only for an internal matching-stage `PlanFailure` with HTTP502 and no response/network/cause ambiguity. A poll preserves its cumulative ACK; a reply requires its separately negotiated v2 receipt and repeats only the immutable chunk/end. A second failure still closes. Other HTTP statuses, capability failures, old clients, authority/source/Cancel and trust checks remain strict. SSL predicates, per-attempt deadlines, receipt TTLs, memory, inference and financial budgets do not change. No wire, central Relay or shared Platform change is introduced.

The new Native poll/immutable reply REDs fail before the classifier change; legacy and negative-status controls remain passing. Offline checks and later matching-version QA must be recorded separately. This follow-up does not establish the underlying cause of an intermediate network/proxy failure or waive user review and release checks.

# Reliable Native command delivery — proposal

Status: **implementation authorized 2026-10-23; offline qualification in progress; not deployed**. Issue: ENG-344; current Draft PR: #2794. Historical source observations below are pinned to `2ae9cfecef710ed59efe475435240c46cae5165d`. The user approved continuing the concrete paired implementation after the design review. Live acceptance remains a separate gate. This is a transport fix for the ChatGPT subscription Native peer, not a new rule for every Matrix Agent provider.

## Problem and evidence

The current Host removes infer and Cancel commands with `requests.splice(0, 32)` before the HTTP response is received by Native. A lost response can therefore lose the command. Native's infer high-water prevents repeat dispatch but cannot recover an unseen Cancel. Its conservative v1 poll failure behavior is necessary until delivery is reliable. [Host poll](https://github.com/HamedMP/matrix-os/blob/2ae9cfecef710ed59efe475435240c46cae5165d/packages/gateway/src/bots/chatgpt-plan-peers.ts#L167), [Native dispatch and cleanup](https://github.com/HamedMP/matrix-os/blob/2ae9cfecef710ed59efe475435240c46cae5165d/desktop/src/main/chatgpt-plan/peer.ts#L176).

The latest real short test passed; the next real streaming test failed after 15.533 seconds with `peer_poll / network_error / ERR_SSL_PROTOCOL_ERROR / before_headers`. This locates a Native-to-Matrix control-poll failure, not its external TLS cause. `before_headers` does not prove that Host never received the request. This design does not establish the cause of the older 16-minute failure or qualify any 30-minute run.

Two offline counterexamples on the actual unchanged v1 registry fail as expected: original infer lost after poll-response loss, and original Cancel lost after poll-response loss. Four controls pass: SSL fail-closed, source-change termination, infer execution deduplication, and unchanged v1 dequeue. These are design evidence, not passing v2 implementation tests. Private evidence is retained in the task's `poll-delivery-design-20261022/red-tests/`; do not publish incident identifiers, messages, credentials or private runtime URLs.

## Scope and invariants

Add an explicitly negotiated v2 **control-command delivery** path: bounded retention, receipt acknowledgement, and at most one extra same-session poll attempt. Preserve v1, existing signed enrollment/device pin, owner/runtime authorization, model selection and request/reply payloads.

Polling/ACK is not model progress. It must not renew inference admission expiry, inference inactivity, user approval, funded credential/reservation expiry, credit or cost budgets. It never resubmits an inference HTTP request, model reply/chunk, user turn or tool operation. No new persistent queue, credential, permission scope, TLS exception, origin redirect or proxy setting is introduced. Host/Native process restart ends the old session; the proposal promises same-session dispatch deduplication, not crash-durable exactly-once execution.

## Wire contract and authorization

Keep existing connect/proof/session, v1 poll, infer/Cancel and reply strict schemas byte-compatible. Define new schemas in `packages/contracts/src/chatgpt-plan-poll-delivery.ts`, exported through existing package conventions. Do not add optional ACK fields to strict v1 objects. [Existing strict contracts](https://github.com/HamedMP/matrix-os/blob/2ae9cfecef710ed59efe475435240c46cae5165d/packages/contracts/src/chatgpt-plan-peer.ts#L27).

| Route | Auth/source of truth | Request and body limit | Response | Public |
| --- | --- | --- | --- | --- |
| Existing `/api/chatgpt-plan/device/*` | Existing verified runtime Native bearer, principal owner, runtime routing, pinned proof/session | Existing schemas/limits | Existing wire | No |
| `POST /api/chatgpt-plan/device/capabilities` | Same verified Native bearer + owner + exact current session | Strict `{version:1, sessionId:UUID}`; 512 encoded bytes before JSON parsing | Strict `{version:1, sessionId:UUID, pollDeliveryVersion:2}` | No |
| `POST /api/chatgpt-plan/device/poll-v2` | Same bearer + owner + exact current session + locked v2 mode | Strict `{version:2, sessionId:UUID, ackThrough:uint48}`; 512 encoded bytes before parsing | Strict `{version:2, sessionId:UUID, acknowledgedThrough:uint48, deliveries:Delivery[]}` | No |

`uint48` is integer 0 through existing `0xffffffffffff`; `Delivery` is strict `{deliverySequence:positiveUint48, request:ExistingV1InferOrCancel}`. Batch length is at most 32. Response bytes stay capped by existing `CHATGPT_PLAN_PEER_POLL_BYTE_LIMIT` (**46,918,320 bytes**), including the new envelope; do not raise the cap for wrappers. It is separate from the tiny request-body cap, model output/chunk limits, file upload limits and model context. [Existing byte/count limits](https://github.com/HamedMP/matrix-os/blob/2ae9cfecef710ed59efe475435240c46cae5165d/packages/contracts/src/chatgpt-plan-peer.ts#L61).

Reuse runtime bearer verification, constant-time UUID comparison, generic error mapper and `private, no-store`. Cookies/dev-default are denied; no wildcard CORS or user-supplied identity headers. Schema failure is 400, forbidden owner/auth is existing 401/403, conflict is 409, unavailable/expired session is 503, oversized body is 413. None may echo provider text, tokens or internal paths. [Existing route boundary](https://github.com/HamedMP/matrix-os/blob/2ae9cfecef710ed59efe475435240c46cae5165d/packages/gateway/src/bots/chatgpt-plan-peer-routes.ts#L18).

Register the two specific 512-byte `bodyLimit` middlewares before the wildcard; skip these paths in the old generic limiter. For these tiny new DTOs, also read at most 513 actual encoded bytes from the request stream, rejecting/canceling at byte 513 before JSON/Zod parsing. Never call `c.req.json()` first. This makes the route's actual-byte guarantee independent of declared Content-Length; it does not assert a production HTTP framing vulnerability in current Hono.

Separate **lookup without renewal** from **touch after validation**: current `session()` touches the lease too early for the new operations. Capabilities is read-only and neither touches the lease nor locks the mode. Rejected ACKs, rejected concurrent polls and schema/auth failures do not prune, renew or close another current session. No new database writes are needed.

## Negotiation and mixed versions

Host session state is `UNDECIDED -> V1_LOCKED | V2_LOCKED -> CLOSED`. After all admission checks, the first valid poll atomically locks one mode without an intervening await. The other mode returns 409. There is no same-session upgrade/downgrade, ACK import, or revival. Capabilities alone does not lock mode.

| Host / Native | Behavior |
| --- | --- |
| Old / current 2ae | Existing v1 behavior and narrow preconnect recovery; ambiguous SSL failures still close. |
| New / old | Unchanged v1 schema and dequeue; first v1 poll locks v1. |
| New / new | Validate exact-session capability, mark v2-attempted **before sending** its first v2 poll, then use only v2. |
| Old / new | v1 may be selected only before any v2 attempt, using the explicit legacy gate below. Otherwise fail closed and offer use of the known old Native build for new tasks. |
| Host rolled back during v2 | Close that Native session and its calls. Never switch its pending run to v1 or resubmit it. A later normal enrollment is a new session for new work. |

**Legacy gate:** a bare 404, HTML200, malformed capability, TLS/timeout, 401/403, 409 or 5xx is not proof of an old Host. The initial implementation must default to fail-closed for an unrecognized capability response. Automatic legacy selection is permitted only if review identifies an existing authenticated, source-bound installed-Host version with an explicit supported-v1 mapping; otherwise it is excluded from this first implementation. Do not add a new version-discovery protocol or persistent switch just to enable fallback. Preserve current Native artifacts for old Hosts instead. This deliberately limits new-Native/old-Host compatibility rather than silently abandoning ACK guarantees.

## Retained command ledger and ACK

Keep one in-memory ledger per exact Host peer session; one Host registry remains its owner. `deliverySequence` is independent of infer `sequence` and covers both infer and Cancel. Allocate it only on first publication. Retained entries have immutable IDs, payload, original infer `expiresAt` and first-publication time. Sequence exhaustion closes the captured session; never wrap or reuse numbers.

1. Validate owner/session, mode, expiry, ACK and poll admission before any mutation. Recheck the captured peer after asynchronous boundaries. A stale handler may close only its captured peer, never a newly connected one.
2. `ackThrough == lastAcked` is idempotent. A higher ACK may prune only the contiguous already-published prefix up to `highestSent`. A lower, future or invalid-prefix ACK returns 409 without renewal/pruning. Apply accepted ACK and mode lock as one synchronous registry transition.
3. Respond with `acknowledgedThrough == accepted request ackThrough`, followed by a contiguous prefix beginning at `ackThrough + 1`. Replay retained entries with their exact original command. Later new tail commands may join a new batch; do not permanently cache batches by ACK value.
4. Once published, an infer stays in the ledger until its delivery is ACKed or the session closes, even if the owner cancels or the model completes. Completion is not a receipt ACK. Cancel must remain after the pending infer is removed.
5. Accepted ACK may be applied even if its HTTP response is lost. Repeating the same ACK is safe. Never restore pruned entries or roll the ACK cursor backward.

Native validates the full bounded response, exact session, attempt and `acknowledgedThrough` before effects. It handles only a contiguous delivery prefix. Advance `lastHandledDelivery` after each command is safely handled locally: an infer's existing high-water is consumed and its call registered, an invalid/expired infer receives an acknowledged safe rejection (or known terminal reply conflict), or a Cancel has applied its abort fence/no-op. Receipt ACK does not wait for model completion. Unexpected handling/reply failure closes the session without inventing an ACK.

Existing infer ID/sequence and expiry checks remain mandatory before model dispatch. Duplicate infer delivery never emits a failure reply over the original active call and never calls inference again. The delivery cursor and infer high-water are constant-size per session. All inference requests keep their original source, grant and run binding.

## Cancel priority

Cancel priority means no silent loss, bounded delivery and cancellation before new dispatch when both commands are visible. It cannot guarantee instantaneous remote Stop across a broken network.

- Remove a provably unsent, unnumbered infer when it is canceled; it cannot have executed and needs no delivery gap or Cancel.
- For an already-published infer, retain its immutable prefix entry and enqueue a separate Cancel. Never remove/reorder numbered entries.
- Select unnumbered Cancels before unnumbered new infers. The ledger reserves four of its 32 slots for Cancels, matching at most four concurrent inference calls. Admission also checks encoded bytes and leaves room for their bounded Cancel envelopes.
- Native pre-scans each completely validated batch for Cancels and applies active-call abort fences first. The pre-scan only records bounded Cancel IDs/aborts existing calls; it must not advance infer high-water out of order. In the normal ordered pass, a canceled new infer consumes its own high-water without dispatch; both entries can then be ACKed in order. For `[infer A(sequence 1), infer B(sequence 2), Cancel B]`, A executes once and B never executes. This uses only the bounded batch/calls, not an unbounded tombstone map.
- A later Cancel cannot change an already-frozen response; it wakes the next poll and remains until ACK. Repeated Cancel is a safe no-op. If no reserved capacity remains, close the captured peer and abort its Native calls; do not evict an unacknowledged Cancel to admit new work.

## Long-poll concurrency and recovery

Simple `polling -> 409` would reject a recovery while the original server long-poll still waits. Use a single logical poll per peer with **at most two cumulative HTTP waiters**: original and one same-ACK recovery. Different ACK or a third waiter is 409 without lease renewal. Each waiter observes its own request abort signal.

Only join while that logical poll is waiting, before publication. Use one original 10-second deadline; joining or aborting a waiter never restarts it. If all waiters leave, retain the logical wait only until its original deadline, command wake or session close. On publication, freeze one immutable batch and **atomically retire the current in-flight pointer immediately**. Joined waiters hold that batch; their HTTP tails do not block a new poll with a valid higher ACK. Cleanup changes shared state only when both the peer and logical-poll identities match the captured objects. Old finally/timer handlers cannot erase a new poll or peer.

Do not cache an empty response by ACK: the next normal poll often has the same ACK and must observe new Cancel. Recheck request abort, captured current session and expiry before each response. Closing/expiry wakes and drains waiters/timers. Normal valid poll touch retains the existing 30-second peer lease; coalescing is not a new lease grant.

Native v2 recovery is a proposed separate predicate, not an edit to v1 eligibility:

- At most one extra poll for a current, non-aborted exact session, including before any infer is received. Cancel/Stop, source/grant/runtime/auth-generation change and session replacement terminate immediately.
- Retire/abort the failed attempt; each response/error has a captured connection/session/attempt fence. Late results cannot dispatch, ACK or close a newer attempt.
- Reuse the exact handled cursor; do not reconnect/enroll or resubmit model/reply POSTs. Extra attempt has one fixed **15-second** deadline, matching existing poll timeout; no backoff loop or sliding window. Only a fully valid current response resets the consecutive-failure count. Existing 30-second peer lease can expire sooner and wins.
- Initial proposed error set is existing proved-preconnect network codes plus the observed generic Chromium `ERR_SSL_PROTOCOL_ERROR`, only at the v2 poll network boundary (`before_headers` or `body_read`). This additional code is **a review gate, not enabled by this document**. Apply certificate/trust/pinning, auth, source and caller-abort hard rejections across the normalized error/cause chain **before** positive retry matching; for example `ERR_SSL_PROTOCOL_ERROR` plus `CERT_HAS_EXPIRED` must reject. Do not copy the existing Chromium-code-first predicate for this expanded v2 purpose. Each attempt uses the same strict HTTPS verification; no certificate-warning bypass or security settings change. Auth/mode/schema/size and unknown errors remain fail-closed. No blanket TLS/reset/timeout allowlist.
- This guarantees safe bounded command re-delivery under the approved fault; it does not repair or explain the external TLS fault. Repeated failure still produces a failed run.

Explicitly classify **both** `poll` and `poll-v2` as poll transport in Native `post()`: each gets the existing 15-second deadline and existing 46,918,320-byte response cap. Today its `path === 'poll'` checks would incorrectly give a new path ordinary POST's 10 seconds / 2 MiB. Add a >2 MiB valid v2 response regression without increasing the existing poll cap. Reply/capability/other POST budgets stay separate. [Current path-specific limits](https://github.com/HamedMP/matrix-os/blob/2ae9cfecef710ed59efe475435240c46cae5165d/desktop/src/main/chatgpt-plan/peer.ts#L71).

## Memory, time and cleanup bounds

All values below are proposed protocol-internal ceilings, not increases to user runtime or funding limits.

| Resource | Ceiling / expiry | Overflow or expiry |
| --- | --- | --- |
| Queued + published-unACKed commands | 32 total, including completed infer entries and retained Cancels; four Cancel-reserved slots | Reject new infer; never evict sent entries; close captured peer if Cancel cannot be retained |
| Queued + unACKed infer bodies | 4, independently of existing pending-call cap 4 | Reject admission before allocating/copying body |
| Encoded ledger / response | Existing 46,918,320-byte cap; account envelope + reserved Cancel bytes | Reject before append; never truncate commands |
| Published unACKed entry | Fixed 30 seconds from first publication; no renewal on replay/ACK/poll | Close captured session before processing a late ACK |
| Unsent Cancel | Fixed 30 seconds from enqueue | Close captured session; no silent expiration |
| Unsent infer / running inference | Original admission expiry/inactivity, source and funds rules | Existing behavior; poll/ACK is not progress |
| Logical poll / HTTP waiters | Original 10 seconds; max two cumulative waiters; no post-publication current pointer | Reject conflicting/third admission; abort/drain on close |
| Application-owned response emission | At most two unfinished waiter/emission slots per peer; fixed 15 seconds from publication | Abort only that emission and release its slot; retain session/ledger under their original expiry |
| Native poll / one recovery | Existing 15 seconds per attempt; at most one extra | Second consecutive failure closes session |
| Host peer liveness | Existing 30-second lease, existing 5-second sweep; expiry also checked on access | Drop only captured expired peer |

Check expiry before ACK/pruning/renewal. Bound the ledger by encoded bytes at admission, using the actual v2 envelope overhead, and avoid retaining multiple serialized copies of a large body. Freeze one batch/encoding and share it among joined waiters. At most two published encodings are application-owned across the two slots; each is at most the existing poll cap, with emitted chunks at most 64 KiB. Account retained ledger bodies, frozen encodings and in-progress chunks separately in tests, including escapes. The encoded-byte accounting is not an assertion that total JavaScript heap equals that number.

Use one earliest-expiry timer per ledger, plus access checks. ACK pruning invalidates that entry's expiry effect and re-arms from the remaining entries' original deadlines; it never creates a later deadline. A delayed expiry callback must confirm captured peer, exact retained entry and still-unACKed status before closing anything. ACK just before an old deadline followed by that deadline cannot close the acknowledged session; a different still-unACKed expired entry still can.

For v2 only, use Hono's existing `hono/streaming` helper to emit the same JSON wire with bounded serialization, request-abort handling and a fixed 15-second emission deadline from publication. A peer has at most two **application-owned** unfinished waiter/emission slots across waiting and published responses. Retiring the logical-poll pointer does not release a slot; writer completion/abort `finally` releases only its own slot. A next normal poll can use the completed recovery response's freed slot while an old tail remains. Reject extra admissions without touching lease/ACK.

An individual waiter's request abort, response cancel, write failure or emission deadline **ends only its own emission**, preserving the session, retained commands and their original TTL. Native must be able to abort its failed original attempt and recover that same session. Session closure is reserved for existing authority/session/lease expiry, fixed unACKed-command expiry, explicit peer disconnect/replacement and resource/sequence invariant failure. Run Stop continues to Cancel its own inference, not unrelated calls. Old emission cleanup cannot abort a replacement or erase a new poll. Explicitly wire request abort and response cancel; Hono only auto-wires request abort on old Bun, and `StreamingApi.write()` catches write errors, so its resolution is never proof of delivery. Emit bounded chunks, release listeners/deadline/own slot in one finally, and use receipt ACK as the sole pruning proof.

Tests must exercise actual route/response-consumer lifecycle, including published-original response abort followed by successful same-ID recovery, old-emitter cleanup after new session, slow-read capacity and 15-second single-emitter cleanup. Do not equate `c.json()` construction with network completion. These are future qualification tests; the current six counterexample/control tests do not cover them. This bounds retained application batches/streams, not OS socket buffers or physical delivery. No new dependency or generic server transport refactor is needed.

Disconnect, rebind, source revocation, lease/command expiry and shutdown clear ledger, timers, wakes and pending calls. Only the registry owner closes shared database resources. In-memory state is deliberately lost on process restart; do not persist user message bodies to add recovery here.

## Implementation boundaries and verification

One independent paired Host/Native protocol change is required; a Native-only retry patch cannot deliver these guarantees. Keep the 416-line registry below the repository's size threshold by extracting a focused delivery helper before adding behavior; avoid a generic queue framework. Contracts, Host ledger/routes and Native receipt logic form one reviewable vertical change; real acceptance/public docs follow separately.

Required tests, all with real production modules and local inference seams: exact infer/Cancel response loss; ACK request/response loss; repeat/lower/future ACK; wrong owner/session/mode/body; cancellation of unsent/sent/same-batch infer; calls execute once; first-mode race; original poll still waiting; publication followed by higher ACK; empty poll then Cancel; third/slow waiter cap; old finally/new session races; 32/4/bytes/sequence limits; fixed command TTL/lease; source revocation; all mixed-version outcomes. Cover retained completed infer, cancel-reserve exhaustion and authority/idle/funding invariants. Tests must first fail on missing v2 behavior, not missing imports, and keep v1 characterization passing.

Then wire real Native peer -> Hono bearer/body boundary -> registry -> synthetic stream -> reply/chunk ACK, with controlled response-loss seams. A successful offline test is not GUI/TLS/30-minute qualification. Only after paired Preview authorization: exact Host SHA + Native SHA/asar, short turn, larger stream, Stop/new turn, controlled recovery, then true continuously working 10/30-minute tests and full-screen Electron screenshots. Waiting for a human or simulated clocks are not busy-run evidence.

## Rollout, rollback and authorization

1. **Current authorized phase:** reviewed protocol implementation and offline regression. No model request, GUI action, paired Preview update or production/shared Platform deployment is part of this phase.
2. **After protocol review and implementation authorization:** RED->GREEN in the isolated worktree, focused regressions/types and independent review. Keep model-request, grants, funds and TLS validation invariants. User review still precedes formal Greptile/release CI as previously agreed.
3. **After explicit paired Preview update authorization:** drain known test runs without replaying unknown writes; update the existing dedicated Host first (v1 remains supported), then only this task's matching Native app/profile. Registry restart ends old sessions; do not promise live migration. No Main/shared Platform/production rollout is implied.
4. **Rollback Native first:** finish or explicitly stop/drain its test run, swap to the known v1 Native and enroll a new session for new work. **Rollback Host:** coordinate/drain affected v2 sessions first; emergency rollback still makes them nonresumable. A v2 session never downgrades after 404/503. Verify artifact, mode and no replayed pending/unknown operations.
5. A separate public documentation PR in private `FinnaAI/matrix-os-site` under `content/docs/` is a release deliverable. Document bounded recovery, Stop and compatibility without incident identifiers or private topology. This proposal does not authorize creating or publishing that PR now.

See [implementation plan](poll-delivery-v2-plan.md). Existing limitation/acceptance reports remain authoritative about unpassed live cases; this proposal cannot be reported as a completed runtime fix.


### 2026-10-23 Native-only 502 recovery follow-up

Paired QA exposed an intermediate gateway HTTP 502 closing the negotiated peer while a reply recovery was still eligible. A roughly 30-minute failure is not by itself proof of an aggregate run deadline. The follow-up uses the same existing one-retry budget only for an internal matching-stage `PlanFailure` with HTTP502 and no response/network/cause ambiguity. A poll preserves its cumulative ACK; a reply requires its separately negotiated v2 receipt and repeats only the immutable chunk/end. A second failure still closes. Other HTTP statuses, capability failures, old clients, authority/source/Cancel and trust checks remain strict. SSL predicates, per-attempt deadlines, receipt TTLs, memory, inference and financial budgets do not change. No wire, central Relay or shared Platform change is introduced.

The new Native poll/immutable reply REDs fail before the classifier change; legacy and negative-status controls remain passing. Offline checks and later matching-version QA must be recorded separately. This follow-up does not establish the underlying cause of an intermediate network/proxy failure or waive user review and release checks.

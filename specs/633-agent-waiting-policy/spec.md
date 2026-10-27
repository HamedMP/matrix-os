# ENG-344: unified agent execution and waiting

Ticket: https://linear.app/matrix-os/issue/ENG-344/investigate-unified-matrix-agent-runtime-approval-output-and-upload

## Intent and correction

The requester approved the T3 approach, then explicitly clarified that fixing long-running failures is the core requirement. The earlier first pass only suspended work-idle during human waiting, distinguished timeout from Stop, and added Native Mobile attachment preflight. It left a managed ten-minute turn limit in place and therefore did not satisfy the original goal. This amendment supersedes that scope; the earlier commits and validation remain historical evidence only.

## Runtime contract

- An ordinary active turn is busy until terminal completion or cancellation, even when it emits no output. No default aggregate run deadline or progress-idle timer may terminate it. Session idle reclamation runs only when there are no active turns. Do not emit fake progress to keep a turn alive.
- Apply this user semantic across managed Matrix AI Chat, Recipe Bot and existing owner-backed Claude, Codex, Pi, OpenCode, Hermes and OpenClaw adapters. A model source and a coding harness are distinct. Keep source-specific credential/protocol requirements and explicit trusted timeboxes separate.
- Keep bounded preparation/startup, connection/header/control requests, individual inference/tool requests, human permission TTLs, output/parser buffers, model input/context budgets, credit/spending checks and OS isolation. A cancellable owned stream follows its run lifecycle rather than an ordinary one-shot request timeout. This is the explicit long-stream interpretation of the constitution’s external-call bounds.
- Do not make credentials permanent, extend paid admission, remove source revocation, increase monetary budgets or automatically replay an operation whose effects may already exist. The retired funded CLI contract may still provide an absolute credential deadline; that compatibility input must not be generalized to managed Pi.

## Managed Pi and Recipe Bot

Remove the ten-minute default aggregate deadline from managed Chat and Bot orchestration. Bound each setup operation independently at 60 seconds. Setup cancellation must settle without waiting for an uncooperative dependency; late runtime/start results must be cleaned rather than admitted after Stop.

An active execution binding has a renewable lease. The gateway renews every 30 seconds; each renewal attempt is bounded at 30 seconds and Stop drains it for at most one second. Recheck exact owner/chat/run/generation/root authority before and after asynchronous renewal. Registry renewal preserves the existing inference AbortController, cannot create a binding or revive revoked/expired state, and unbind precedes host Stop.

The supervisor owns a 900-second Pi execution lease with a 30-second sweep. It renews only existing unexpired Pi runtimes with the exact generation. Profile version 2 records the lifecycle change in its digest. Replace fixed systemd RuntimeMaxSec and nested worker/launcher/client/server aggregate timers with this lease and connection/caller cancellation. Keep all short control/connect bounds. The distinct restricted collaboration profile retains its 90-second workload lifetime.

Worker units use BindsTo and After for matrix-scope-runtime.service. The supervisor service has a 60-second systemd watchdog, serviced by a fixed notifier every 15 seconds after server startup; notifier execution is bounded at five seconds with at most one child. Workload units belong to other cgroups and cannot satisfy that watchdog. Keep CPU/memory/PID, filesystem, root, capability and broker-only network limits unchanged. Supervisor startup reconciles old Pi workers instead of assuming ownership. Failed cleanup keeps the runtime revoked and retries; no late worker reply may become a success after Stop or lease expiry.

## Other adapters

- Claude: remove default busy-turn 30-minute progress-idle. Preserve a 30-second first-valid-frame startup bound and 10-second stdin bound, explicit injected timeboxes, and separate human question expiry.
- Native Codex App Server: remove the whole-turn 24-hour and turn-no-progress cutoffs. Keep separately started tool/command bounds, human-wait handling, bounded event correlation and terminal-only idle hibernation. Legacy Codex must not retain its own default ten-minute child kill.
- Coding store, Pi and OpenCode: no nested default ten-minute aggregate deadline. Credential preparation remains bounded at 30 seconds. OpenCode response headers/control calls remain bounded; owned SSE and message completion follow run cancellation.
- Hermes: remove the default 30-minute turn timer. Preserve startup, individual RPC and interruption/cleanup bounds.
- OpenClaw: pinned official runtime 2026.7.1, commit 842a951d5d0843aa6eb77575dc9867bf0603835c, accepts timeout 0 as its no-run-timeout sentinel. Submit agent once, synchronously accept run identity, then observe that same run through bounded agent.wait requests. Wait timeout is not terminal and never resubmits agent. Retain bounded event buffering and best-effort remote abort on local Stop or an unconfirmed transport failure. Upstream timer-safe sentinel and upstream liveness are separate from Matrix’s policy.

## Waiting, cancellation and retry

A busy turn may wait for a person without consuming a session-idle deadline. Permission authority remains bounded independently: Claude questions default to 30 minutes; managed integration approvals retain ten minutes. Other provider policies remain adapter-specific. Multiple outstanding controls do not resume idle after the first response. Final resolution, expiry and close clean pending state and timers.

Approval submission rechecks expiry after asynchronous authority validation. At or after expiry it refuses and consumes the wait once, even if the timer callback has not run. It cannot execute a prepared mutation, deliver a late answer or authorize replay.

First cancellation cause wins. Explicit Stop must immediately settle local waiting even when a worker ignores cancellation. Bot durable state and canonical result remain cancelled if a late worker reports success. Cleanup, confirmed process exit and effects already produced are distinct; do not claim cancellation rolls them back. Resume/retry must revalidate current authority and input selection and must never automatically replay uncertain writes.

## Output and input

Cumulative display output and active-work lifetime are independent. Keep a bounded presentation, mark truncation once, and continue consuming control, state and terminal events. Per-frame/parser/queue limits protect memory and protocol integrity. Full raw-log archival, guaranteed lossless backpressure, document extraction and durable draft storage are separate deliverables; do not claim them from display truncation. The task result must inventory remaining adapter-specific cumulative limits and all preserved bounds precisely.

Native Mobile validates the current instance/model/options and attachment selection before upload or optimistic draft clearing, including retry. Invalid input remains editable/removable with safe copy; server ownership and actual-file admission remain authoritative. The approved attachment follow-up raises ordinary uploaded files to 10 MiB each and attachments to 20 MiB combined. Preserve eight attachments, four images, 2 MiB/image, the separate 8 MiB image total and default-funded aggregate image budget 1 MiB. Preserve image capability/type checks. Immutable submitted-file aliases may be read in hash-bound 32 KiB chunks; workspace/integration binary artifacts remain 1 MiB and whole-text reads remain 192 KiB. Generic upload limits, extraction and model context admission are separate contracts.

## Auth and resource matrix

| Boundary | Authority and validation | Public? | Bound/cleanup |
| --- | --- | --- | --- |
| Existing canonical Chat/Stop/control routes | Existing owner/chat/run access, strict canonical schemas, expiry recheck after awaits | No | Existing body/rate bounds and terminal cleanup |
| Internal runtime.renew | Gateway-owned supervisor Unix socket; strict runtime handle and exact execution generation; existing unexpired Pi profile only | No | 900-second renewable lease, bounded lanes/sockets, 30-second sweep |
| Managed binding renewal | Current owner/chat/run/generation/root and source authorization, checked around awaited host renewal | No | Capped registry, no replacement cancellation signal, Stop abort/drain |
| Bot worker command socket | Supervisor-owned relay to exact active runtime/generation; bounded single frame | No | Caller/connection/lease cancellation; short commands bounded |
| Per-inference broker | Existing owner/source/model/credit admission and cancellation, fresh credential resolution | No | Existing request, token, cost and concurrency bounds |
| Native attachment preflight | Advisory shared contracts; actual server admission remains source of truth | No new endpoint | Existing counts/bytes/types, safe failures preserve local edit state |

No new external HTTP endpoint, permission grant, database schema or credential export is introduced. Workers cannot call the supervisor renewal socket. All new maps, timers and subprocesses must be bounded and drained. Log error types server-side; expose only reviewed generic error copy.

## Verification and deliverables

Response-capacity follow-up: native ChatGPT, the gateway success-body schema, inference readers and worker HTTP replies share a 1 MiB raw UTF-8 limit. Only inference JSON envelopes receive a separate `6 * raw + 4096` byte bound; tool/session controls and 512 KiB egress bodies retain their existing guards. Verify the reproduced 551958-byte complete response, exact raw limit, UTF-8, worst-case JSON escaping through the real gateway writer and Unix sockets, raw/frame overflow refusal, terminal-error rejection and shutdown cleanup. This fixes inconsistent capacity without claiming to resolve an unclassified live timeout or to provide lossless unlimited streaming.

### Approved chunked response follow-up (2026-10-22)

The user selected end-to-end chunked streaming instead of a larger whole-response limit. Bot inference explicitly requests `responseMode: stream`; the native peer, registry-owned gateway route, Unix broker, private HTTP bridge and Pi fetch all participate. Keep the 1 MiB cap only on legacy whole-body replies. Stream transport chunks are at most 64 KiB UTF-8; one SSE event/parser buffer remains capped at 1 MiB, and one JSON transport frame at `6 * 64 KiB + 4096`. These are independent of prompts, files, context and cost budgets. A large terminal event can still exceed the event cap and fail safely; arbitrary response size is not promised.

Native chunk POSTs await an exact session/id/sequence acknowledgement. Each pending inference holds at most one unconsumed chunk; consumer progress and socket/HTTP drain provide backpressure. Start/chunk/end frames are strictly validated and sequenced. Missing end, old sessions, invalid acknowledgement, oversized frame, cancellation and truncated upstream streams fail closed. No model request is retried after any output. Transport close cancels the registry-owned inference without treating the normal request half-close as cancellation.

Native control-poll recovery is limited to one consecutive allowlisted connection-establishment failure before response headers, on the same current session with an uncancelled inference. Reset this budget only after a complete valid poll. Preserve the request high-water mark, inference idle clock and source/cancellation authority. The existing gateway poll destructively dequeues commands without a delivery ACK; reset, generic timeout, body-read loss, unknown error, HTTP/schema failure and stale binding must therefore still close the peer and cancel active calls. Never replay inference, re-register a peer or retry an uncertain model/write request. Record fixed error-code and phase enums only. Verify lost-cancel delivery both before headers and during body reads, second consecutive failure, Stop during recovery, draining cancelled calls, ACK conflict, unchanged idle/high-water behavior and rejection of mixed TLS/permission/unknown errors. Reliable replay/ACK protocol changes remain a separate follow-up.

Success is a commit barrier: hold the sole valid `response.completed` and optional `[DONE]` until upstream EOF, validated model/status/order and final authority revalidation. Earlier deltas are provisional. Real installed Pi SDK fixture tests must prove that early tool arguments cannot execute before this barrier, including errors after `[DONE]`. Preserve existing input, token/cost, funds, concurrency and per-call deadlines, plus the native per-POST 10-second stall protection. New protocol frames use existing authenticated peer endpoints and exact runtime-generation authority; no new credential or permission scope is introduced.

Implement and verify in five boundaries: contracts; native parser/peer/service; gateway peer and inference; Unix/HTTP/worker transport; provenance-matched Electron acceptance. Include bounded synthetic replies whose aggregate exceeds 1 MiB, UTF-8 splits, late errors, missing/duplicate terminal, slow consumers, Stop/revocation/close, unsupported old peers, and unchanged egress/control budgets. Developer docs and the separate public-site documentation PR remain deliverables.

### Active stream deadline correction (2026-10-22)

The stream follow-up still retained absolute per-inference clocks inside a busy turn. A live Native subscription reproduction continued producing output but failed after approximately 121 seconds. An agent turn without an aggregate deadline does not solve this nested failure.

For owner-backed streaming inference, retain bounded setup and genuine stream inactivity protection rather than an absolute response lifetime: 120 seconds for the paired ChatGPT path, 30 seconds for owner Anthropic HTTP, and 11 minutes at the private worker bridge. Reset only on actual upstream bytes or validated sequenced nonempty chunks, never device polling or UI progress. Dispose timers/readers on completion, Stop, lost authority and connection closure. Native reply POSTs retain their independent ten-second bound; existing control, buffer, admission and concurrency protections remain.

Bound owner Anthropic credential/authority reads separately at 30 seconds, both before sending and after receiving headers or chunks. Ignore late results after timeout/Stop. Gateway upstream-idle timers pause during bounded-chunk consumption/backpressure; a slow downstream consumer must not masquerade as an idle provider. Keep Native POST and private transport stall limits independently enforceable.

Native request `expiresAt` remains a bounded admission/replay check. Once a stream is admitted it is governed by stream progress and its exact caller/connection cancellation; the original admission timestamp must not kill healthy ongoing work. Legacy whole-body inference keeps its previous absolute deadline. Coalesce existing bounded provider-read output into bounded transport chunks so many small SSE events do not each require their own serial HTTP acknowledgement. Hold terminal success until the existing EOF/authority barrier.

Funded inference is a separate contract. Keep its 120-second generation guard, admission queue and all credential, reservation, in-flight and relay absolute lifetimes unchanged. These clocks are not derived from one another and must not be described as one universal ten-minute policy. This correction neither increases funds nor automatically replays failed requests.

Verify RED/GREEN through production parsers, authenticated peer registries and real private Unix sockets: active streams crossing old deadlines; actual inactivity; bounded setup/first data; Stop, source revocation and closure; terminal EOF; unchanged funded absolute expiry. Fake-clock regressions do not qualify the requested real 10/30-minute Electron evidence. Rebuild only after source is frozen, retain exact bundle/client provenance, then repeat fresh live short, moderate streaming, Stop/new-turn and continuous-work cases on the existing Private Preview.

1. RED on the prior implementation: a silent busy turn crosses each old ten/fifteen/thirty-minute or 24-hour threshold and fails. GREEN: the same turn stays busy, then completes or accepts Stop. Do not simulate ordinary provider progress during the gap.
2. Exercise real local Unix sockets through gateway client, supervisor controller, systemd launcher relay and worker command server with synthetic workers and fake time. Prove renewal across old deadlines, lost lease reclamation, stale generation/late completion rejection, connection cleanup and Stop headroom under bounded load.
3. Verify current authority revocation, funding/credit refusal, per-inference cancellation, renewal stalls, setup stalls, human expiry ordering, late worker success and terminal-only session reaping. Use small output thresholds/fixtures for truncation and protected controls.
4. Run affected gateway, coding, scope-runtime and deployment-contract tests plus configured typechecks after source settles. Do not rerun the unchanged 3,123 Native tests for this backend increment. Preserve the earlier Native TypeScript baseline of 63 existing errors in 15 files; never call the whole project green.
5. Independently review lifetime/authority/Stop/output boundaries and publish a Chinese limitation ledger with code versus live evidence, exact source and test provenance, remaining limits, cost/security tradeoffs and follow-up boundaries.
6. Update this spec, developer behavior documentation and applicable Trellis guardrails. Prepare the separate public documentation change in FinnaAI/matrix-os-site; it remains a separate constitution deliverable.
7. Reuse Draft PR2794 and the existing authorized Private Preview. Record exact new source/bundle/worker/Electron provenance before testing. The previous 05d466 short live successes cannot qualify this runtime correction. Preserve the user’s ordering: implementation and private acceptance, user review, then formal Greptile/CI. No production/shared Platform deploy or merge.

Applicable surfaces are Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile. Shared backend semantics do not establish live five-surface or Native device qualification. No source policy may depend on one renderer.

## Session-local Native command receipts

The paired ChatGPT subscription peer additionally uses explicit capability and
v2 command-delivery DTOs. Retain infer/Cancel until handled receipt ACK, preserve
same-session dispatch deduplication and Cancel priority, and keep queues,
waiters, emitted buffers and original deadlines bounded. V1 remains strict for
old Native clients; the new service selects v2 and fails closed on unrecognized
old Hosts rather than guessing a safe downgrade. Model/reply POSTs, enrollment,
grants and funds are not replayed or extended. Source/session/attempt identity
and certificate refusals win over transient recovery. Full auth matrix, byte and
time bounds, compatibility and Host-first rollback sequence are specified in
[the protocol design](poll-delivery-v2-design.md) and
[implementation plan](poll-delivery-v2-plan.md). Local synthetic inference and
Node HTTP tests do not qualify real TLS or 10/30-minute Electron operation.

## Lost acknowledgements and Stop synchronization

Electron Desktop and shared Web Chat treat admission transport failure as an unknown outcome. A bounded authenticated read may confirm the exact request ID, original input, selection and modes; it must never infer acceptance from the latest Run or automatically resend the write. Definitive client/auth/conflict rejections remain errors. An unchanged manual retry retains its admission key while acknowledgement is unresolved.

A successful Stop retains a selected-Chat snapshot synchronization obligation even when the event stream reports open. Reads retry with capped backoff until the cancelled Run is no longer active; navigation, authority changes and unmount dispose the obligation. The canonical terminal state stays authoritative; clients do not invent revisions or turn a completed Run into a cancellation.

Qualification separates controlled transport-fault regression tests from Electron Desktop live observations. Previous long-run evidence remains pinned to its original source; a new UI build does not retroactively qualify other surfaces, providers or untested output/expiry boundaries.
# Admission readback after lost acknowledgement

An unchanged first send retains its create, upload and admission request identity before Chat creation. A lost create/admission response must not produce another Chat or model turn on an explicit unchanged retry. Edited payloads and a deliberate new draft get a separate identity; acceptance clears the retained attempt.

Agent/Bot execution can legitimately override composer settings. Recovery therefore checks the saved original request hash through a read-only authenticated lookup, rather than comparing those effective settings. The browser and server share the same original-request preimage (parts, selection, modes and optional execution root); revision and request key fence writes separately. Existing strict Run response schemas are unchanged.

|Method/path|Authentication and scope|Validation|Effects and failures|
|---|---|---|---|
|GET `/api/chats/:chatId/turn-admissions/:clientRequestId?requestHash=<sha256>`|Existing authenticated principal, personal owner scope and owner-filtered canonical repository lookup|Bounded canonical Chat/request IDs; exactly one lowercase 64-hex original-request hash; existing message/input projection versions|Reads an existing first admission only; no mutation, reconciliation, inference, queue dispatch or authority expansion. Missing/mismatched ownership, request or hash does not acknowledge admission; missing service is a safe server failure.|

An optional subsequent transcript read improves local hydration; its failure cannot erase an already confirmed admission, and a stale transcript cannot replace the confirmed snapshot. An older Host without the lookup fails closed and never triggers an automatic second admission. Tests cover create/response loss, ordinary attachments, effective Agent/Bot overrides, mismatched original hashes, cross-owner reads and old-Host compatibility.

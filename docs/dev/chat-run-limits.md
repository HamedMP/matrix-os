# Agent execution, waiting and input limits

Tracks [ENG-344](https://linear.app/matrix-os/issue/ENG-344/investigate-unified-matrix-agent-runtime-approval-output-and-upload).
Implementation contract: [633-agent-waiting-policy](../../specs/633-agent-waiting-policy/spec.md).

## Busy turns and idle sessions

An ordinary busy turn has no Matrix-imposed aggregate execution deadline. Silence during an active turn does not make its session idle. Session reclamation starts only after active work ends. This follows T3 Code’s separation of busy turns and session idleness; see its [session manager](https://github.com/pingdotgg/t3code/blob/b5a0696a989a171530cc3c0ff831a99f51ce6f09/apps/server/src/orchestration-v2/ProviderSessionManager.ts).

This policy is shared by managed Matrix AI Chat, Recipe Bot and owner-backed Claude, Codex, Pi, OpenCode, Hermes and OpenClaw adapters. They are different executors: selecting a model in Matrix AI does not execute its corresponding coding CLI. A trusted caller may still request an explicit task timebox. Retired funded-CLI compatibility contracts retain their supplied credential deadline; they do not establish the policy of managed Matrix AI. The separate restricted collaboration profile retains its own 90-second workload limit.

Each startup, credential preparation, connection, control exchange, individual model request and started tool keeps its own bound. A long-lived owned stream can continue while its run is active and cancellable; it is not an unbounded ordinary HTTP request. Upstream service outages, credential revocation, failed authorization, exhausted credit or tool/inference budgets can still stop a run. Removing an aggregate clock does not guarantee that every task will finish.

## Managed workers and ownership leases

Matrix AI and Recipe Bot use a renewable execution lease rather than a fixed worker lifetime. The gateway renews every 30 seconds while that exact owner/chat/run/generation/root binding remains current. Each renewal attempt has a 30-second bound. The supervisor accepts renewal only for an existing, unexpired Pi runtime with the exact execution generation; renewal cannot create a worker or increase its isolation privileges. A missing gateway is reclaimed after a 15-minute lease, checked every 30 seconds.

Worker profile version 2 removes the old 15-minute systemd total lifetime and binds worker units to the supervisor service. CPU, memory, task count, mount, root and broker-only network restrictions remain. A 60-second systemd watchdog monitors the supervisor event loop independently of its lease sweep; its fixed notifier runs every 15 seconds. Supervisor failure/restart stops bound workers. These systemd properties require host qualification; fake-clock and socket tests cannot prove live systemd behavior.

Setup steps remain independently bounded at 60 seconds. Long bot.run IPC follows caller cancellation, connection closure and the lease instead of a second aggregate timer. Stop stops renewal, revokes the current binding, cancels inference and requests worker termination. It does not refresh credentials or grant permission.

## Human waiting, Stop and retry

Human waiting is an explicit state, with a separate response lifetime. It does not run a session-idle clock during a busy turn and cannot extend an approval’s authority. Claude questions expire after 30 minutes by default. Recipe Bot questions retain a 24-hour response lifetime and end the current worker turn; answering starts a subsequent attempt. Managed integration approvals retain their 10-minute response lifetime. Other adapters retain their own human-control policies; these numbers are not universal provider limits.

Submission rechecks expiry after asynchronous ownership and authority checks. An expired, cancelled or closed request cannot execute a prepared mutation, accept a late answer or be replayed. Pending controls and timers are cleaned on terminal paths.

Updated Bot clients explicitly opt in to saved-answer recovery. If a blocking question is saved but continuation admission is unconfirmed, Chat shows the saved state and a Resume action. Refresh recovers eligible state from owner Postgres. Resume uses only the stored answer, original request identity and current revision; it rechecks the owner, responder, expiry, direct binding and original waiting task. A matching canonical admission confirms delivery without resending it. Cancellation or an expired question cannot create replacement work. This does not replay approvals, grants or integration effects. Legacy clients keep their pending-only interaction projection.

User Stop and shutdown are cancellation outcomes. The first stop cause wins, including a worker’s late success. Local cancellation must settle even if the worker does not respond. Resource cleanup can outlive that settlement; a cancellation event alone does not prove physical process termination or rollback of earlier tool effects.

OpenClaw submits an agent task once, uses the pinned runtime’s zero timeout sentinel and observes the same run through bounded agent.wait requests. A wait timeout means keep waiting, not resubmit the task. Transport failure triggers best-effort remote cancellation. A lost acknowledgement can leave effects uncertain; no adapter automatically replays a possibly completed write.

## Credentials, cost and context

A credential lease, a model request and an agent turn have separate lifetimes. Managed Pi obtains credentials through the gateway for each inference and revalidates current authority. Credential expiry does not become a total conversation deadline; it also cannot be ignored. Funding admission, usage holds, credit/budget checks and cancellation remain authoritative for each paid request. No credential becomes permanent and no balance or spending ceiling is increased by this change.

Model context windows, prompt/input token admission, output-token budgets and maximum tool/inference steps remain bounded. Display truncation cannot increase a model’s context. A file being uploaded successfully does not mean that it can be parsed or admitted as model input.

Managed Bot context maintenance runs before ordinary inference, after complete tool results and accepted corrections. It shares the existing two-summary and total-inference budgets, respects cancellation, preserves current images and complete tool pairs, and bounds private tool/assistant context. If preserved person text cannot fit, the run stops before inference instead of silently cutting that input. Terminal session save performs no summary model request. These changes do not establish the root cause of earlier slow finalization without matching phase evidence.

Bot inference uses explicit chunked streaming from the native ChatGPT peer or upstream HTTP response through the gateway, Unix broker, private HTTP bridge and Pi worker. There is no cumulative 1 MiB wire-response cap on this path. Each UTF-8 transport chunk is at most 64 KiB. A single ChatGPT SSE event and held terminal buffer remain bounded at 1 MiB, including events that repeat the complete output. One JSON stream frame is at most `6 * 64 KiB + 4096` bytes. These parser and buffer limits can still reject an oversized individual event; streaming does not promise arbitrary model output or increase context and output-token budgets.

Each native chunk waits for an exact session/request/sequence acknowledgement. The peer buffers at most one unconsumed chunk, and the Unix/HTTP writers wait for downstream drain. Nonterminal SSE output from the same bounded provider read is coalesced into bounded chunks; an individual small SSE event need not incur its own serial acknowledgement.

Legacy Native control polling may retry one consecutive connection-establishment failure while the same current session has an uncancelled inference. A complete valid poll resets that budget. Only allowlisted connection-refused, connection-attempt timeout and DNS failures before response headers qualify. A reset, generic timeout, body-read failure, unknown error, failed authorization or changed source still closes the peer and cancels its active calls: the existing poll protocol dequeues commands before delivery acknowledgement, so an ambiguous loss could hide Stop. This recovery does not resend model requests, reset request sequence or stream-idle clocks, or change funding protections.

Owner-backed streams keep inactivity protection rather than a total response deadline: 30 seconds for owner Anthropic, 120 seconds for paired ChatGPT and 11 minutes at the private worker bridges. Actual upstream bytes or validated nonempty sequenced chunks refresh these waits; polling or UI activity cannot. Connection/setup and first-data waits remain bounded. A native reply POST keeps its separate 10-second limit. Native request expiry still rejects stale/replayed admission; it does not terminate a healthy stream already admitted. Legacy whole-body calls keep their original total deadlines.

Owner Anthropic credential and authority reads are also separately bounded at 30 seconds, including revalidation after headers and during consumption. Stop cancels those waits without accepting late results. Gateway upstream-idle waits pause while an already received bounded chunk awaits consumption; downstream ACK, connection and private bridge limits remain separate stall protection.

Funded inference retains its independent 120-second generation guard and all credit, reservation, credential, relay and concurrency protections. These safeguards can still stop an individual funded request; they are separate from owner subscriptions and from an agent turn that can perform multiple requests. Stop, owner/source changes and transport close cancel upstream work. No partially received model request is automatically retried.

ChatGPT text and arguments are provisional until a single valid completed event, actual upstream EOF and final authority validation. The native and gateway validators hold completed and `[DONE]` until that barrier, because the installed SDK can treat `[DONE]` as completion before reading later errors. An incomplete, late-error or invalid-terminal response cannot authorize tools through this path. The Unix reader also requires a valid end frame and clean EOF before completing its HTTP response.

Legacy whole-body replies retain a shared 1 MiB raw UTF-8 cap and a separate `6 * raw + 4096` inference JSON-envelope bound. This compatibility path does not imply a 1 MiB limit on the new streaming path.

These response limits do not set the size of a user's message or uploaded file. Outbound egress reads retain their separate 512 KiB body limit, and non-inference tool/session control replies retain their existing frame limit. Gateway and worker changes must ship together in the same host bundle, with a matching native peer for ChatGPT streaming; older components cannot qualify the new path.

## Output presentation and protocol guards

Electron Desktop renders updated persisted commentary directly rather than replaying it through a typing animation. Hidden windows also catch up to the latest received snapshot without waiting for animation frames. Visible streamed/final messages retain their existing animation; reaching a terminal state reveals the received text. This corrects display lag without changing transport, retained-preview or model-output limits.

Matrix Agent (`matrix_pi` and `matrix_bot`, across their available credential/model routes) saves up to 8 MiB of JSON-encoded assistant text per turn in existing owner Postgres Chat messages. It rotates to a stable continuation message before any message exceeds 96 KiB of encoded text; the canonical 128 KiB message schema stays unchanged. Reload, pagination and export read those same rows. At most 64 source identities and 192 segments are tracked, using counters rather than a full reply cache. One visible retention-limit notice fits within the turn budget; after the limit, tools/state/terminal events continue and skipped text never resumes with a missing middle. This is complete output within the bound, not an unlimited archive. Previously discarded text cannot be restored from Chat. Continuation rows have stable source/ordinal IDs and a shared display projection joins consecutive same-chat/turn/run segments for complete reply display and Copy. Stored assistant whitespace-only parts are valid; user inputs remain nonblank. Older readers can collapse a prefix or reject these new snapshot values, so the updated Host/Web and Native readers must be released together. Do not roll back readers by deleting owner output.

Coding-agent adapters remain distinct: their shared preview retains a 96 KiB JSON-encoded prefix and at most 64 identities. Credential sidecars are only retained with complete masked placeholders and their original message/offset binding. Matrix Agent does not emit such sidecars; unexpected sealed captures are rejected rather than rebound to continuation IDs.

The shared managed Pi/Recipe Bot worker no longer uses 2,000 lifetime events as a text cutoff. It bounds encoded text at 8 MiB per turn, keeps a 12 KiB encoded buffer and one serial awaited send chain, and flushes on a timer, full buffer or actual model/tool boundary. Timed refresh is 250 ms initially and one second after 1,600 text publications, with a visible mode notice; small later deltas do not wait for 12 KiB. Tools retain an independent bound of 60 starts, at most three updates each and a terminal, including cancellation. Once the text-byte limit is reached, one honest notice is published and later text is omitted while tool/status delivery continues. Long turns can therefore publish more than 2,000 broker requests; the locked SDK awaits listeners and financial/inference allowances do not increase. The saved model session, model context, upload limits and transport-frame bounds are separate.

This worker correction applies to managed Matrix AI Chat and Recipe Bots across their supported model routes. It does not change the separate coding-agent CLI adapters, context/token/funding limits, tool count, cancellation, or canonical preview retention. It needs an updated Host bundle; it changes neither the native control DTO nor the central Relay.

Run activity keeps the complete durable semantic ledger in owner Postgres, including approval/input outcomes and terminal records. Detail responses retain a bounded 500-activity window; full history and export read the durable ledger. New activity or terminal binding after 500 records must not fail the run, delete earlier history or lose control evidence. This preserves Main's transcript recovery behavior. It is separate from bounded in-memory/CLI previews and does not provide complete raw CLI-log archival.

Claude no longer applies 16 MiB as a cumulative stdout lifetime budget. It still rejects an oversized single or unfinished frame and retains its bounded event queue. Hermes truncates its 96 KiB presentation while retaining the 512 KiB transport-frame guard. Pi and OpenCode distinguish cumulative display from bounded protocol records and publication queues; omitted presentation gets a generic notice, while controls cannot silently disappear. Each publication remains independently bounded and cancellable.

These changes do not implement universal lossless backpressure. Shared CLI, managed Pi, Recipe Bot and OpenClaw retain bounded queues; a malformed/oversized frame or exhausted control capacity may still fail a run. Recovery snapshots retain their existing 96 KiB limit. Native and legacy Codex still use a 16 MiB append-only event file with absolute reader offsets; adapting its display and reserved control budget is a separate follow-up. Native Codex’s 500-item bound applies to concurrently unfinished items, which are released on completion; it is not a cumulative tool-count limit.

Large durable results should be explicit artifacts with their own owner access, retention and quotas. Unified complete raw-log archival, output download and parser recovery are not delivered by this preview truncation change.

## Bot answers and steering

A blocking Bot question ends its current worker turn. Clicking Answer submits a validated continuation under an interaction-derived request ID. It starts the next Bot turn directly when idle. If the asking worker is still finishing a broker exchange, the server durably holds that answer and dispatches it automatically when the worker releases. Web and Electron show the submitted answer with an automatic-continuation status, rather than offering manual Steer, edit or reorder controls. Pending-answer cancellation remains available. Queue placement does not bypass owner, responder, expiry, revision or budget validation.

Retries first reconcile the same owner-scoped queued/claimed admission and payload. An asking turn that finishes between direct admission and queue admission gets one fresh-revision retry; the answer is never converted into a steer. A worker refuses new steering while publishing a blocking question, waiting for the person, stopping, or closing. Corrections acknowledged before that question drain at the next safe phase boundary under the existing cancellation and inference/tool budgets; the question remains unresolved and steering grants no approval. Both Recipe Bot and ordinary managed Matrix AI Chat require the worker's explicit `acknowledged: true`; successful command transport alone is insufficient. Refused queued steering retains the original queued message, and uncertain transport is not automatically replayed.

## Attachments

Native Mobile applies the shared managed-input policy using the current selected instance, model and options before upload or optimistic draft clearing. Retry applies the current selection policy again. The same server admission and actual-file validation remain authoritative across Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile.

Managed Matrix AI input is capped at eight attachments, four images, 2 MiB per image, 10 MiB per ordinary file and 20 MiB total. Images require model vision support and PNG, JPEG or WebP, with a separate 8 MiB image total. Default Matrix-funded images additionally share a 1 MiB total budget. Other upload endpoints and picker limits have separate purposes and do not authorize larger Agent input.

Submitted ordinary files use an immutable, hash-bound capture and bounded 32 KiB reads. Accepting a 10 MiB file does not insert its full contents into model context. Workspace and integration binary artifacts retain their separate 1 MiB limit; whole-text artifact reads retain their 192 KiB limit. Retry checks the current selection before sending again.

Invalid attachments remain available for removal or editing with a safe error. PDF/Office extraction, durable drafts and attachment retention are separate work; upload is not document parsing.

## Qualification

Current submitted-file aliases remain authoritative for their request. Availability notes for a specific historical sequence do not invalidate a current upload with the same label. Previously captured aliases still fail closed after their bound request ends; filenames never confer read authority.

### Native receipt delivery

New Electron service composition explicitly selects the session-bound v2 peer;
the strict v1 adapter remains for older Native clients. Signed enrollment,
device pin, runtime bearer and owner checks are unchanged. A positive capability
response must match the current session before `/poll-v2`. An unrecognized old
Host, including capability 404, cannot trigger automatic fallback. Deploy a
matching Host before the new Electron client; a v2 session cannot downgrade
during rollback or resume a previous model request after re-enrollment.

Host retains original infer/Cancel commands until a cumulative receipt ACK.
Native acknowledges handled commands rather than completed inference, keeps
infer execution deduplicated, and applies same-batch Cancel before dispatch.
This is ephemeral session-local delivery, not durable exactly-once execution.
A successful catalog renewal with identical model content preserves the current
peer and active calls. Catalog object identity is not continuing authority; real
model, grant, account or runtime changes still invalidate the captured source.
The ledger holds at most 32 commands, four unACKed infer bodies, and four slots
reserved for Cancel. Published receipts expire after 30 seconds without renewal;
unsent Cancels use enqueue time. The existing encoded poll cap remains
46,918,320 bytes. Tiny capability/poll request bodies are limited to 512 actual
bytes before parsing. At most two application-owned waits/emissions are held;
coalesced same-ACK waiters share the original 10-second long-poll deadline.
Each published response has a fixed 15-second
emission deadline. Response cancellation frees its own slot, never the ledger.

V2 permits one additional same-session poll for the existing preconnect codes
or the generic Chromium SSL protocol error, with strict HTTPS verification.
Certificate/trust/auth/source/abort and unknown causes fail closed before any
positive match. Both poll versions retain 15-second response deadlines and the
same byte cap. V1 keeps its narrow preconnect-only recovery. Model inference,
credentials and tool operations are never replayed. Stream replies have their own opt-in receipt protocol below; poll-v2 support alone never authorizes their retransmission. Poll/ACK
does not count as progress or extend inference idle, approval or funded limits.
For v2 only, an exact per-POST deadline at the pre-header/body-read boundary
can use that same one-retry budget. The caller must still be live; a foreign
TimeoutError, caller idle/lifetime timeout, cancellation, changed source or
coincident trust/unknown failure does not qualify. Two 15-second attempts can
reach the unchanged 30-second command receipt expiry, so recovery is not
guaranteed and expiry still fails closed. Repeated control failure still ends
the run; this does not diagnose or repair an external TLS fault. See the dedicated v2 design/plan under
`specs/633-agent-waiting-policy/` for compatibility and rollback.

For negotiated v2 only, an intermediate HTTP 502 may use that same existing recovery budget. It does not establish whether Host consumed commands or bytes: the next poll keeps the exact cumulative receipt and a reply retransmits only its immutable chunk/end. Only the internal matching-stage HTTP failure without ambiguous response/network/cause metadata qualifies; other HTTP statuses, capability failures, certificate/trust failures, changed source and Cancel stay fail-closed. A second consecutive poll failure or second reply failure still closes the connection. Legacy polling and unnegotiated replies gain no retry, no model/tool is re-executed, and no timeout, receipt TTL or funding allowance increases. This Native-only classification change requires no Host wire, central Relay or shared Platform deployment.

The same authenticated capabilities request can explicitly opt into reply delivery with `includeReplyDeliveryV2=true`. Only a matching `replyDeliveryVersion: 2` response authorizes one retransmission of the current immutable stream chunk or end, after a 100ms abortable delay. Old clients receive the original strict response; old Hosts lacking the flag get no reply retransmission. Negotiation must precede the first poll; already queued, unpolled work is allowed. Each POST retains its 10-second deadline and source/Cancel checks. The narrow poll-v2 network classifier applies, with certificate, authorization and unknown causes taking precedence. Its exact own-POST deadline may also reuse the same one-retransmission budget, only with the same current source, uncancelled caller and negotiated reply receipts. The 10-second attempt deadline remains unchanged; no inference is repeated. A second failure still fails closed; no model or tool is executed again.

Host retains only the current chunk sequence, UTF-8 SHA-256 and consumption ACK. An identical replay does not enqueue bytes twice or renew idle. Each chunk admits at most two HTTP ACK subscriptions in total, including timed-out/aborted attempts, so abandoned Promise reactions cannot grow under sequential disconnects. The authenticated reply route reserves at most eight input/emission slots before buffering, at most two concurrent ACK waiters per stream, and a fixed 10-second body/ACK/emission deadline. Actual bytes are bounded even without an accurate Content-Length. Aborting an HTTP waiter preserves accepted bytes; it does not cancel inference. Slots release on response emission completion/abort or an earlier error.

Electron coalesces small upstream reads while the one current reply waits for its
ACK. The first nonempty item is sent immediately; later pending bytes flush
within 50ms, at the 64KiB chunk boundary, or on source completion/failure. This
avoids spending a network round trip on every small SSE delta. The pending batch
is capped at 64KiB; the producer can additionally hold one already-read source
item of at most 64KiB while waiting for space. Together with the immutable
64KiB reply in flight, retained raw payload is bounded at 192KiB, independently
of the existing parser allowance and JS/string/JSON overhead. A full pending
batch pauses reading. Stop, source changes and refusal discard unsent buffers
and cancel the producer; non-cooperative iterator cleanup cannot delay Stop.
Earlier partial bytes may flush before a source error, but no success end is
sent for that error. Completion still requires the existing EOF validation.
Batching neither adds concurrent POSTs nor changes receipts, retry budgets,
credential/funding checks, or the Host/Relay protocol. See
`specs/633-agent-waiting-policy/stream-coalescing.md` for regression evidence.

At most 32 final transport receipts per peer expire after 120 seconds, with FIFO eviction and session/shutdown cleanup. They acknowledge only an already accepted ordered end, independently of normal EOF cleanup of the old inference signal. Cancellation before end acceptance creates no receipt; a receipt never asserts canonical run success, renews credentials or re-enrolls another session. This negotiated extension changes Host/Gateway and Native readers, not the central Relay. See `specs/633-agent-waiting-policy/reply-delivery-v2-plan.md` for compatibility and rollout gates.

Electron Desktop keeps failure-only subscription diagnostics in a dedicated, profile-isolated subdirectory of its application logs. The recorder accepts fixed error categories, stages, HTTP statuses, strict request/run/computer IDs and a generated UTC timestamp; it does not persist prompts, responses, credentials, account labels, raw errors or filesystem paths. Records are capped at 128 entries and 64 KiB, have a 24-hour TTL with recurring cleanup, and use a single asynchronous writer. Shutdown drains for at most one second; an atomic filesystem rename already in progress may still complete afterward. Storage failure does not fail inference or prevent exit, and diagnostics are never uploaded automatically.

Transport failures retain their peer operation stage, a fixed Chromium/Node error code when available, and whether failure preceded headers, occurred during body reading or followed binding revalidation. Response-stream failures additionally persist a fixed parser branch (for example body read, framing, UTF-8 or terminal identity) and re-sanitized response enums. Body-read connection errors remain distinguishable after HTTP 200 without retaining event contents or changing acceptance/retry behavior. Changed bindings use a separate stale-source category. These classifications help locate a subsequent failure; adding a recorder cannot retrospectively determine the cause of an earlier generic `run_failed`. Only the narrowly defined negotiated control/reply recovery above changes retry behavior; adding the recorder does not. Request deadlines and resource/funding protections remain.

Regression tests must keep a silent busy turn active past each old aggregate deadline, then complete it or Stop it. They must separately prove lost renewal, stale generation, revoked authority, pending-control expiry and remaining funding/resource protections. Use fake clocks, small output fixtures and real local Unix sockets; do not substitute fake provider progress for elapsed time.

Record source commit, backend bundle, worker profile and local client provenance before live acceptance. Earlier short Chat/Bot successes from another bundle do not qualify this behavior. Local tests do not prove a deployed runtime, upstream provider liveness or live systemd cleanup. User review precedes formal Greptile/CI and merge; public documentation in the separate site repository and the applicable live surface/device evidence remain release requirements.

Electron Desktop refreshes Bot identity/status metadata on Bot/interaction events, explicit model changes and the existing bounded status poll. Streamed text revisions update the transcript without issuing another Bot definition/status read for every chunk. Identity lookup failures still disable controls conservatively; this does not authorize cached identities, change network deadlines or increase inference/funding budgets.

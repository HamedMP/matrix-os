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

User Stop and shutdown are cancellation outcomes. The first stop cause wins, including a worker’s late success. Local cancellation must settle even if the worker does not respond. Resource cleanup can outlive that settlement; a cancellation event alone does not prove physical process termination or rollback of earlier tool effects.

OpenClaw submits an agent task once, uses the pinned runtime’s zero timeout sentinel and observes the same run through bounded agent.wait requests. A wait timeout means keep waiting, not resubmit the task. Transport failure triggers best-effort remote cancellation. A lost acknowledgement can leave effects uncertain; no adapter automatically replays a possibly completed write.

## Credentials, cost and context

A credential lease, a model request and an agent turn have separate lifetimes. Managed Pi obtains credentials through the gateway for each inference and revalidates current authority. Credential expiry does not become a total conversation deadline; it also cannot be ignored. Funding admission, usage holds, credit/budget checks and cancellation remain authoritative for each paid request. No credential becomes permanent and no balance or spending ceiling is increased by this change.

Model context windows, prompt/input token admission, output-token budgets and maximum tool/inference steps remain bounded. Display truncation cannot increase a model’s context. A file being uploaded successfully does not mean that it can be parsed or admitted as model input.

Bot inference uses explicit chunked streaming from the native ChatGPT peer or upstream HTTP response through the gateway, Unix broker, private HTTP bridge and Pi worker. There is no cumulative 1 MiB wire-response cap on this path. Each UTF-8 transport chunk is at most 64 KiB. A single ChatGPT SSE event and held terminal buffer remain bounded at 1 MiB, including events that repeat the complete output. One JSON stream frame is at most `6 * 64 KiB + 4096` bytes. These parser and buffer limits can still reject an oversized individual event; streaming does not promise arbitrary model output or increase context and output-token budgets.

Each native chunk waits for an exact session/request/sequence acknowledgement. The peer buffers at most one unconsumed chunk, and the Unix/HTTP writers wait for downstream drain. A native chunk POST retains its 10-second stall bound; existing individual inference deadlines remain 30 seconds for owner Anthropic and 120 seconds for funded or ChatGPT calls. Those are per-call bounds, separate from an agent turn that can perform multiple model calls. Stop, owner/source changes and transport close cancel upstream work. No partially received model request is automatically retried.

ChatGPT text and arguments are provisional until a single valid completed event, actual upstream EOF and final authority validation. The native and gateway validators hold completed and `[DONE]` until that barrier, because the installed SDK can treat `[DONE]` as completion before reading later errors. An incomplete, late-error or invalid-terminal response cannot authorize tools through this path. The Unix reader also requires a valid end frame and clean EOF before completing its HTTP response.

Legacy whole-body replies retain a shared 1 MiB raw UTF-8 cap and a separate `6 * raw + 4096` inference JSON-envelope bound. This compatibility path does not imply a 1 MiB limit on the new streaming path.

These response limits do not set the size of a user's message or uploaded file. Outbound egress reads retain their separate 512 KiB body limit, and non-inference tool/session control replies retain their existing frame limit. Gateway and worker changes must ship together in the same host bundle, with a matching native peer for ChatGPT streaming; older components cannot qualify the new path.

## Output presentation and protocol guards

The live canonical assistant preview retains a prefix within a 96 KiB JSON-encoded text budget and at most 64 message identities. It reserves one visible truncation notice, then continues consuming tools, state and terminal events. Later text, including a final explanation, may be omitted. Credential sidecars are retained only when their complete masked placeholder fits; truncation cannot move an existing credential’s message offset. This is not a full output log.

Run activity uses a rolling 500-row window. Pending approvals, input requests, unconsumed submission claims and terminal records are protected; resolved input ledgers are removed as a group. Removed activity IDs are broadcast through the existing outbox. If every slot is protected, ordinary display may be dropped; a control that cannot be persisted fails closed.

Claude no longer applies 16 MiB as a cumulative stdout lifetime budget. It still rejects an oversized single or unfinished frame and retains its bounded event queue. Hermes truncates its 96 KiB presentation while retaining the 512 KiB transport-frame guard. Pi and OpenCode distinguish cumulative display from bounded protocol records and publication queues; omitted presentation gets a generic notice, while controls cannot silently disappear. Each publication remains independently bounded and cancellable.

These changes do not implement universal lossless backpressure. Shared CLI, managed Pi, Recipe Bot and OpenClaw retain bounded queues; a malformed/oversized frame or exhausted control capacity may still fail a run. Recovery snapshots retain their existing 96 KiB limit. Native and legacy Codex still use a 16 MiB append-only event file with absolute reader offsets; adapting its display and reserved control budget is a separate follow-up. Native Codex’s 500-item bound applies to concurrently unfinished items, which are released on completion; it is not a cumulative tool-count limit.

Large durable results should be explicit artifacts with their own owner access, retention and quotas. Unified complete raw-log archival, output download and parser recovery are not delivered by this preview truncation change.

## Attachments

Native Mobile applies the shared managed-input policy using the current selected instance, model and options before upload or optimistic draft clearing. Retry applies the current selection policy again. The same server admission and actual-file validation remain authoritative across Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile.

Managed Matrix AI input is capped at eight attachments, four images, 2 MiB per image, 10 MiB per ordinary file and 20 MiB total. Images require model vision support and PNG, JPEG or WebP, with a separate 8 MiB image total. Default Matrix-funded images additionally share a 1 MiB total budget. Other upload endpoints and picker limits have separate purposes and do not authorize larger Agent input.

Submitted ordinary files use an immutable, hash-bound capture and bounded 32 KiB reads. Accepting a 10 MiB file does not insert its full contents into model context. Workspace and integration binary artifacts retain their separate 1 MiB limit; whole-text artifact reads retain their 192 KiB limit. Retry checks the current selection before sending again.

Invalid attachments remain available for removal or editing with a safe error. PDF/Office extraction, durable drafts and attachment retention are separate work; upload is not document parsing.

## Qualification

Electron Desktop keeps failure-only subscription diagnostics in a dedicated, profile-isolated subdirectory of its application logs. The recorder accepts fixed error categories, stages, HTTP statuses, strict request/run/computer IDs and a generated UTC timestamp; it does not persist prompts, responses, credentials, account labels, raw errors or filesystem paths. Records are capped at 128 entries and 64 KiB, have a 24-hour TTL with recurring cleanup, and use a single asynchronous writer. Shutdown drains for at most one second; an atomic filesystem rename already in progress may still complete afterward. Storage failure does not fail inference or prevent exit, and diagnostics are never uploaded automatically.

Transport failures retain their peer operation stage: an acknowledgement timeout is distinct from an upstream response timeout. These classifications help locate a subsequent failure; adding a recorder cannot retrospectively determine the cause of an earlier generic `run_failed`. This diagnostic change does not alter request deadlines, retry behavior or resource/funding protections.

Regression tests must keep a silent busy turn active past each old aggregate deadline, then complete it or Stop it. They must separately prove lost renewal, stale generation, revoked authority, pending-control expiry and remaining funding/resource protections. Use fake clocks, small output fixtures and real local Unix sockets; do not substitute fake provider progress for elapsed time.

Record source commit, backend bundle, worker profile and local client provenance before live acceptance. Earlier short Chat/Bot successes from another bundle do not qualify this behavior. Local tests do not prove a deployed runtime, upstream provider liveness or live systemd cleanup. User review precedes formal Greptile/CI and merge; public documentation in the separate site repository and the applicable live surface/device evidence remain release requirements.

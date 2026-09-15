# Implementation blueprint after self-review

Date: 2026-09-10. Review baseline: PR #1611 at `ed7a5d78f`, against source at `d80d821b2`. These are proposed contracts, not implemented APIs. This document makes [plan.md](plan.md) concrete; [spec.md](spec.md) remains the product scope.

## Findings that change implementation

| Priority | Evidence and gap | Required design correction |
|---|---|---|
| P1 | `platform-token.ts` has both handle-only and machine/runtime-bound credentials. The plan said “existing verified identity” without choosing which. | Use runtime-bound identity, reject the legacy handle-only credential, and explicitly authorize the speech operation. |
| P1 | `funded-ai.ts` fixes scope to `ai:invoke`; the metering repository debits machine balances. Reusing it is not a drop-in audio integration. | Add typed speech policy and server-verified usage while retaining the existing ledger, machine funding scope, and text-inference behavior. |
| P1 | `startReservation()` returns its cached start response for an in-flight reservation. That response is not an exclusive right to call the provider. | Add a durable dispatch claim; repeated start/status requests never dispatch again. Separate execution, delivery and settlement states. |
| P1 | Draft identity was described without specifying when it changes or how results merge. | Atomic final insertion against the current draft and generation; cancellation invalidates callbacks synchronously, including late permission resolution. |
| P1 | `channel-voice.ts` stores source audio before transcription and downloads into memory before checking actual size. | Preserve owner source attachments; bound streaming downloads and validate redirects/SSRF. Temporary dictation and imported source retention are distinct. |
| P2 | The mobile subscription effect depends only on `computerKey`, and content handling invalidates query snapshots. | Key transport lifetime to user/runtime/generation, merge content locally and fence stale snapshots. Subscribe before connecting. |
| P2 | “One service” could become a prerequisite to rebuilding all Vocal/onboarding behavior before basic recording ships. | Deliver one batch vertical slice first. Later live adapters share contracts without forcing a speculative universal audio framework. |

## Concrete module ownership

| Location | Responsibility | Excluded responsibility |
|---|---|---|
| `packages/contracts/src/speech/` | Versioned Zod schemas, safe error codes, capability/status/result types | Provider SDK types, browser globals, secrets |
| `packages/platform/src/speech/service.ts` | Admission, dispatch claim, cancellation coordination, outcome normalization | HTTP parsing or microphone handling |
| `packages/platform/src/speech/operations.ts` | Kysely operation metadata and conditional transitions | A second wallet, transcript persistence |
| `packages/platform/src/speech/adapters/openai.ts` | File transcription, bounded upstream I/O, usage normalization | Owner resolution, public error strings |
| `packages/platform/src/speech/media.ts` | Format/duration validation with resource caps | Trusting client MIME/duration |
| `packages/gateway/src/speech/` | Authenticated routes and injected platform client | Direct speech provider credentials/calls |
| `packages/ui/src/speech/` | Pure lifecycle reducer, controller, shared controls and capture adapter | Chat creation or provider selection |
| Extracted kernel transcription tool | Safe owner file opening and injected `transcribe` port | Importing gateway internals or constructing a provider |

Names may adapt to repository conventions. The kernel depends on a narrow contract supplied by gateway composition, not on the gateway package. Web Canvas, Web Desktop and Electron Desktop mount the same controls. Use surface adapters only for transport and microphone permissions. Ship only the file adapter initially; test provider replacement with a deterministic fake. Grok and Gemini dependencies are unnecessary for that first slice.

## First release wire contract

- `GET /api/speech/capabilities`: `contractVersion`, `fileTranscription` readiness, stable unavailable reason, supported encodings, effective byte/duration/text limits. No provider name/key, model catalog or inference-account dependency. Readiness is advisory; admission rechecks it.
- `POST /api/speech/transcriptions`: one multipart audio file plus bounded request ID, source kind and optional language hints. Source kind is `dictation` or `owner_audio`; the gateway derives/authorizes it for each caller. No caller-selected provider, model, owner, funding source, file URL, system prompt or tools. Draft identity remains client-side; the platform does not need chat history or draft text.
- Successful response: `contractVersion`, `requestId`, final `text`, validated `audioDurationMs`, completion status. No speech is a safe explicit outcome that leaves the draft unchanged. All responses use `Cache-Control: no-store` and exclude content from tracing.
- `GET /api/speech/transcriptions/:requestId`: metadata-only status for uncertain outcomes; never replay a transcript. Include execution state and whether a new attempt is safe or may consume allowance again.
- `DELETE /api/speech/transcriptions/:requestId`: idempotent cancellation request, with `bodyLimit` even for an empty body. Return whether execution had already started; do not promise a refund or immediate provider cancellation.
- Mirror the three transcription operations under `/internal/speech/transcriptions`; use the same owner/machine/runtime checks for POST, GET and DELETE. Unknown or foreign operation IDs reveal no ownership details. Validate path IDs and all metadata with bounded Zod schemas.

A POST stays synchronous; this release does not need an audio job queue or persisted response cache. GET and DELETE exist to resolve cancellation and lost-response state. Only the original successful POST carries text. Client retries of transport errors are disabled by default.

### Authentication and allowance

Reuse the machine/runtime lookup and constant-time verification pattern in `ai-funded-policy-routes.ts`. Authenticate bounded credentials before reading audio, verify a currently running machine/runtime and its owner in platform DB, then require explicit `speech:transcribe` policy. The existing runtime-bound credential authenticates the machine; it does not confer speech eligibility by itself. Do not accept the Gemini handle-only token. Revocation must be a checked policy/machine state, not an assumption that HMAC values expire. Future scoped session grants are a separate change.

Introduce a typed operation discriminator in shared admission policy rather than weakening `ai:invoke` to arbitrary strings. Keep speech configuration independent of text-model allowlists. Reservations retain the existing machine account and owner identity; do not silently convert funding into an owner-wide wallet. Owner-wide abuse limits additionally prevent bypass by switching runtime slots. Platform selection pins adapter, model and pricing revision for each accepted operation.

Use the existing ledger transaction primitives through a focused extension. Reservation, operation linkage and settlement mutations are atomic; a failed operation insert cannot leave an untracked hold. Namespace request IDs by operation and verified identity, independent of credential rotation. Preserve promotional/add-on source restrictions and test that speech cannot spend a text-only grant. Allowance configuration must explicitly identify eligible sources; missing speech policy means unavailable. No new customer pricing or automatic add-on purchase is implied.

## Execution, delivery and money are separate states

Persist non-content metadata: verified identity, operation/request ID, source kind, keyed content fingerprint, policy/pricing revision, reservation ID, execution state, cancellation flag, dispatch claim, timestamps/deadline, safe outcome code and normalized usage. Do not store transcript, raw audio, chat context or provider error body. A fingerprint is scoped metadata, not cross-owner deduplication; restrict access and expire it with the operation.

| Transition | Required behavior |
|---|---|
| Receive → validated | Acquire bounded upload capacity; validate actual media. No provider work yet. |
| Validated → reserved | Atomically reserve allowance and link operation. Same ID plus different audio/options returns conflict. |
| Reserved → dispatching | Conditional DB claim granted to exactly one handler, committed before upstream call. Recheck cancellation and policy. |
| Dispatching → succeeded/failed/uncertain | Persist outcome/usage metadata. A timeout or crash after dispatch intent is uncertain, not proof of zero usage. |
| Reserved → cancelled | Win a conditional race against dispatch, release hold once; never call provider. |
| Dispatching + cancel requested | Abort transport best-effort, suppress UI insertion immediately; reconcile billable usage independently. |
| Terminal → settled/released | Idempotent ledger finalization in a transaction; late completion and cleanup cannot debit twice. |

There is no exactly-once provider guarantee across a network/process failure. Guarantee at most one application dispatch attempt per operation, disable hidden SDK retries, and guarantee idempotent ledger effects. A replayed reservation-start receipt is not a new dispatch claim. Do not lease/reassign a dispatched operation to another worker. Recovery reconciles it without redispatching audio.

Cancellation arriving before POST registration creates a bounded authenticated tombstone for that ID; a later POST cannot resurrect it. Rate-limit these writes. Multi-instance cancellation uses the durable flag plus a bounded check/notification path, not only an in-memory AbortController. Every control read/write revalidates owner and runtime.

Set a finite reconciliation deadline in policy. Before rollout, specify how unknown usage closes under the existing conservative settlement mechanism and how later authoritative usage corrects it; do not silently release a possibly billable hold or leave it forever. Customer allowance effects must match documented policy, including cancellation after dispatch. Metadata retention must outlast supported retry/reconciliation windows; once metadata expires, expired request IDs cannot be reused as new operations. Use timestamped bounded request IDs and enforce their admission age.

A lost final response displays: “The transcription result could not be recovered. Trying again may use your speech allowance again.” A deliberate retry uses a new ID and existing local audio only while that attempt remains active. Clear retained audio on success, cancellation, identity change or a five-minute retry timeout. A successful metadata status does not mean text can be downloaded again.

## Shared draft behavior

```text
idle → requesting_permission → recording → uploading → transcribing → idle
                                   └ stop                   └ final inserted
any active state → cancel/identity change → idle (generation invalidated)
any active state → failure → recoverable error (typed draft remains)
```

- Bind to user, machine/runtime, composer instance, draft ID and draft generation. New draft, clear, send, sign-out or runtime change increments generation. Ordinary typing does not. No chat needs to be created to dictate into a new draft.
- The completion action reads the current draft in one store update and appends the final transcript once with appropriate whitespace. It preserves intervening edits and attachments. Do not read a captured textarea value. Track applied request ID within bounded draft state; repeated finals do nothing.
- Keep provisional transcript in a separate preview; never overwrite editable text with partials. On overflow, preserve the complete bounded result in a review area with copy/discard actions; never truncate into the draft.
- All submit paths (button, Enter, shortcut and queued send) share the same active-dictation guard. The guard ends on cancellation or completion. Transcription readiness and selected harness send-readiness are separate.
- Cancel invalidates the attempt synchronously before asynchronous cleanup. Late microphone permission immediately stops every returned track. Navigation tears down the capture session; it never moves an attempt to a newly mounted composer.
- One microphone lease per renderer, with cross-window coordination where available; server admission still prevents simultaneous paid attempts exceeding policy. Switching presentation ends active capture without losing typed draft text. Browser/tab limitations must be tested, not presented as an OS-wide exclusive microphone guarantee.
- Electron grants microphone permission only to the trusted renderer and relevant origin. Preserve embedded untrusted web-content denial. Verify packaged usage description, entitlements and gateway-scoped CSP without broad media/network allowances.

## Media admission and retention

Two limits are independent: compressed upload bytes and decoded audio duration. Initial dictation remains 120 seconds/10 MiB; multipart overhead has its own small cap. Duration metadata alone is insufficient for hostile files. The media spike must prove bounded decode/sample counting or an equally sound duration validation path, including malformed and misleading containers. Cap CPU time, decoded samples, subprocess count, memory and temp bytes. No unbounded transcoding. Explicitly package and maintain a decoder if required; do not assume ffmpeg is installed on the host.

Acquire upload/probe capacity before buffering or decoding, then monetary reservation before provider work. Include gateway buffers, platform buffers, multipart copies and decoder output in the measured memory budget. Initial canary defaults: one active operation per owner, ten admissions per owner per minute and four concurrent media/provider operations per platform process, with a separately configured deployment-wide cap. Shared DB leases/counters enforce aggregate limits across replicas. Reject excess work instead of queueing audio. Validate these defaults under load before expanding them.

Control calls have a 10-second timeout. File POST has a proposed 65-second total deadline starting at upload, with bounded stage budgets; abort signals combine user cancellation and remaining timeout. A slow upload cannot leave the provider a fresh unbounded minute. Return explicit safe timeout states rather than retrying upstream.

The 120-second dictation limit must not silently become the import limit. Inventory existing supported owner files/channel recordings before migration and define a separately bounded `owner_audio` policy with compatibility fixtures. If a previously accepted format/length cannot be supported safely, document the limitation and migration before replacing that caller. No automatic audio slicing or summarization in this release.

Channel source attachments already live in the owner's home. Preserve them according to existing owner retention, even when transcription is unavailable; delete only generated temporary copies. Validate download destinations, reject redirects or revalidate every hop, enforce SSRF protection and streaming byte limits before allocation. Owner-file tools resolve within authorized roots and reject symlink escape. Platform sees bounded bytes, never a caller URL or local path.

## Delivery units and exit gates

| Unit | Reviewable deliverable | Gate |
|---|---|---|
| A: admission/media spike | Actual format, duration, usage and timeout evidence; funding schema migration design | No assumed decoder, price unit or provider access. Synthetic/consented audio only. |
| B: batch vertical slice | Contracts, platform file adapter and ledger extension, gateway facade, shared composer controls behind disabled capability | End-to-end fake provider test, concurrency/crash/cancel tests, no automatic Send and no leaked key |
| C: caller consolidation | Kernel/channel injection, old STT code removal, source-audio preservation | Caller inventory closed, supported import fixtures and retained TTS/telephony tests pass |
| D: surface release | Shared Web Canvas/Web Desktop/Electron Desktop/Web Mobile behavior | Packaged microphone tests, real latency/language evidence, source docs PR; enable only after B/C |
| M: independent mobile fix | Transport selected from device spike; shared pure merge/recovery code | Device deltas, account switch, foreground, replay gap and stale snapshot tests |
| E: progressive/live dictation | File-preview enhancement first, then normalized realtime segments | One final insertion, no duplicate paid fallback, bounded session lifetime and metering |
| F: interviews | Shared session UI, explicit save/start-work, provider adapters and Gemini migration | Canonical tool approvals/deduplication and onboarding parity before old live stack removal |

B may be developed before C completes but cannot be declared consolidated until C passes. M is independently shippable and does not block a validated speech release. Do not require Grok/Gemini realtime rewrites for A–D. Rollback disables speech capability; it never restores a direct runtime-key STT fallback. Deploy additive platform contracts before gateway/client rollout and keep compatibility until supported clients migrate.

For M, extract the existing pure `canonical-chat-content.ts` merger into a runtime-neutral shared export without pulling React DOM into Expo. Subscribe before connection startup; fence every callback and REST response by user/runtime/connection generation. Apply deltas to detail state without list refetch per token; invalidate list membership on creation/deletion and coalesce status changes. Negotiate content protocol explicitly, handle cursor gaps with authoritative snapshots, and reconnect with fresh auth. Compare Expo HTTP streaming against the existing WS route on a real device before selecting one.

Later interview context is explicit and bounded; never send the whole chat/home by default. Dictation has no tools; interview tools exclude computer actions, with save/start-work driven by explicit UI intent. Assistant mode invokes the canonical gateway/kernel tool executor with normal approvals and idempotent identities. Store saved briefs/transcripts only in owner-controlled storage through existing APIs. Changing providers takes effect on a new session, not midway through an active conversation.

## Required failure tests

1. Two POSTs with the same ID; same ID with different bytes/options; key rotation during retry.
2. Crash before reservation commit, after dispatch claim, after provider completion and before settlement.
3. Cancel before registration, during upload, racing dispatch, and after provider success; cancel served by another replica.
4. Missing/foreign/revoked runtime identity and text-only promotional credit presented for speech.
5. Oversized multipart metadata, no Content-Length, malformed media, forged duration and parallel memory pressure.
6. Permission resolves after cancel; typing during transcription; clear/new chat/runtime switch; duplicate final; keyboard send during capture.
7. Channel audio remains available when STT fails; owner file traversal/symlink and redirected download rejected.
8. Mobile account change on the same computer, old snapshot after new delta, duplicate/reordered content, reconnect with an expired cursor, final status received while backgrounded.

These are implementation acceptance tests, not tests executed by this documentation review. Operator allowance/unknown-usage policy and the media/device spikes remain explicit implementation gates.

# Voice Session API and Event Contract

This document defines the shared backend contract for standalone Aoede. The 2026-09-30 product correction supersedes Chat-mounted presentation; exact existing media schemas remain authoritative in `@matrix-os/contracts`. Aoede has a shell-level singleton and explicit backing conversation, not the selected Chat.

Target surfaces for this delivery are `web_canvas` and `web_desktop`. `electron_desktop` predates this work and stays schema-valid in the shared voice capability protocol for backward compatibility, but no Electron host ships in this delivery: an Electron caller is not a qualified Aoede surface and Electron qualification is deferred to a separate follow-up.

## Standalone bootstrap and presentation contract

Authenticated `POST /api/aoede/bootstrap` accepts strict `{clientRequestId, intent: "continue" | "new", projectId?: string, surface: "web_canvas" | "web_desktop"}`. This delivery only launches from the two browser surfaces; `electron_desktop` remains valid only in the pre-existing shared voice capability schema and is deferred to the follow-up. Owner/runtime derive from server configuration/principal. It resolves an owner/runtime/scope-unique canonical conversation pointer transactionally; New uses request-id deduplication and retains old canonical history. Response exposes `{chatId, scope, selection, capability}` using existing selection/capability schemas, plus no credential. No microphone/provider run starts. Missing/deleted/access-lost backing Chat on Continue returns structured unavailable; only explicit New replaces it. Mutations require existing auth, strict Zod/bodyLimit, bounded request IDs and 10-second client timeout. New persistence is owner-local PostgreSQL/Kysely only.

Canonical HTTP/event APIs are the required source for bounded current response captions, exact approvals/input/activity/navigation/artifacts/reconciliation and terminal results. At checkpoint `553fff73d`, approvals and activities project, but qualified native input is rejected and open/apply results remain opaque tool-output JSON rather than accepted Aoede navigation/artifacts. Presentation must not invent voice approval/action/result records. Icon/palette open/focus converge on one controller. Explicit Start invokes existing chat-scoped media APIs. Dismiss stops capture/playback and retains canonical work; End releases media only. History navigation is optional, never required for approval/input/recovery.

## Additive managed synthesis streaming contract

`POST /internal/containers/:handle/speech/syntheses/stream` shares existing runtime HMAC auth, strict `SpeechSynthesisRequestSchema`, funding admission/unique claim/cancellation/settlement. NDJSON frames are strict discriminated objects:

- `{type:"audio", sequence: nonnegative integer, data: bounded base64 PCM chunk}`; chunks max 64KiB decoded, frame boundary even-byte aligned.
- `{type:"end", sequence: nonnegative integer, format:"pcm_s16le_24000_mono", durationMs: bounded nonnegative integer}`.
- `{type:"error", sequence: nonnegative integer, code: existing SpeechSafeErrorCode}`.

Sequence starts at 0 and is contiguous. Format is fixed mono 24kHz PCM S16LE; total max 8MiB, line max 96KiB, duration byte-derived. No end after error; EOF without terminal is failure. Caller cancellation/timeouts abort provider reading and conservatively settle any claimed operation under existing rules; no redispatch/replay. Existing completed synthesis API remains compatible. Gateway consumes chunks incrementally and never sees provider credentials. Interim completed-WAV transcription, if used, is explicitly metered provisional polling, not claimed as genuine realtime recognition.

## Contract principles

- Canonical Chat HTTP/event APIs remain authoritative for durable transcript, runs, activities, tools, approvals, and results.
- The voice channel carries ephemeral media, provisional transcript, playback acknowledgements, and session controls only.
- Final recognized user text is admitted once by the trusted Gateway coordinator through canonical Chat turn admission.
- Provider-native frames never cross the shared client boundary.
- All schemas reject unknown keys and use bounded strings, arrays, binary frames, and sequence numbers.

## Auth matrix

| Route/channel | Caller | Authentication and authority | Public | Limit |
| --- | --- | --- | --- | --- |
| `POST /api/aoede/bootstrap` | Authenticated web shell (Electron deferred) | Existing Gateway principal; server-owned runtime identity; authorized project/scope; idempotent canonical binding | No | 4 KiB body; 10-second client timeout; no media/model dispatch |
| `GET /api/chats/:chatId/voice/capabilities` | Authenticated web shell (Electron deferred) | Existing Gateway principal; read access to exact Chat; runtime policy | No | 10-second request; rate limited |
| `POST /api/chats/:chatId/voice/sessions` | Authenticated web shell (Electron deferred) | Existing Gateway principal; Chat write access; runtime/provider policy and concurrency admission | No | Small JSON body; one active session per admitted Chat/user policy |
| `DELETE /api/chats/:chatId/voice/sessions/:sessionId` | Owning shell | Existing principal plus exact Chat/session binding; idempotent | No | Empty bounded body; 10-second request |
| `POST /api/chats/:chatId/voice/sessions/:sessionId/reconnect` | Owning shell | Existing principal plus session binding; rotates one-time transport ticket and epoch | No | Small JSON body; bounded attempts |
| `WS /ws/chats/:chatId/voice/:sessionId` | Admitted shell transport | Single-use, short-lived, path-bound session ticket minted after authenticated admission; exact Chat/session/principal binding | No | Bounded frame/audio/queue/session lifetime |
| Platform provider credential/session routes | Gateway runtime | Existing verified runtime-to-platform identity plus speech capability policy | No | Provider and budget policy |
| Canonical Chat turn/activity/approval routes | Existing shells | Existing canonical Chat authorization | No | Existing canonical limits |

The transport ticket is not a bearer credential for canonical Chat routes and is not added to the generic query-token allowlist. The exact voice upgrade path owns verification before constructing a trusted request principal. It verifies the digest in constant time, atomically consumes the credential, checks exact allowed Origin/reverse-proxy policy, revalidates Chat/session authorization, and rejects wrong path, principal, or epoch before session mutation. Rate limiting occurs before expensive provider/session work.

## Capability response

```ts
type VoiceCapability = {
  contractVersion: 1;
  status: "available" | "degraded" | "unavailable";
  surface: "web_canvas" | "web_desktop" | "electron_desktop" | "native_mobile";
  transportModes: Array<"relayed_websocket" | "direct_webrtc">;
  turnModes: Array<"hands_free" | "push_to_talk">;
  supportsInterruption: boolean;
  resume: "delivery_aware" | "rebuild_only" | "unsupported";
  sessionOnly: "enforced" | "unsupported";
  actionMode: "conversation_only" | "safe_reads" | "canonical_actions";
  actionCancellation: "none" | "run" | "tool";
  supportsInputSelection: boolean;
  supportsOutputSelection: boolean;
  outputAudio?: VoiceOutputAudioFormat;
  limits?: {
    maxSessionSeconds: number;
    maxIdleSeconds: number;
  };
  reason?:
    | "not_configured"
    | "policy_disabled"
    | "surface_unsupported"
    | "provider_unavailable"
    | "limit_reached";
};
```

No provider key, provider-native model name, internal URL, owner path, or raw upstream error is returned.

Availability is not established by configured adapter presence. Server composition/bootstrap must call the bounded managed-speech readiness probe (or a bounded cache) and require ready transcription plus ready streaming synthesis. Probe timeout, unknown, stale or configured-but-unready state returns `status: "unavailable"`, empty `transportModes` and `turnModes`, and an allowlisted reason. Only `status: "available"` may create or reconnect a session; `degraded` is display-only and also denies both mutations. Simulator capability is test-only and simulator registration must be rejected when `NODE_ENV === "production"`.

## Session creation

Request:

```ts
type CreateVoiceSessionRequest = {
  clientRequestId: string;
  turnMode: "hands_free" | "push_to_talk";
  memoryMode: "ordinary" | "session_only";
  requestedTransport?: "relayed_websocket" | "direct_webrtc";
  selection: CanonicalChatSelection;
  interactionMode: CanonicalInteractionMode;
  permissionMode: CanonicalPermissionMode;
  locale?: string;
};
```

Response:

```ts
type CreateVoiceSessionResponse = {
  sessionId: string;
  chatId: string;
  limits: {
    maxSessionSeconds: number;
    maxIdleSeconds: number;
    maxQueuedAudioMs: number;
  };
} & (
  | {
      outcome: "created" | "rotated_unconsumed";
      status: "connecting";
      transport: {
        kind: "relayed_websocket";
        url: string;
        ticket: string;
        expiresAt: string;
        epoch: number;
      } | {
        kind: "direct_webrtc";
        ephemeralCredential: string;
        expiresAt: string;
        epoch: number;
        controlUrl: string;
        controlTicket: string;
      };
    }
  | {
      outcome: "existing_consumed";
      status: VoiceSessionState;
      reconnectRequired: true;
      transport?: never;
    }
);
```

Creation is semantically idempotent for the same principal, Chat, and `clientRequestId`; reuse with different semantic input is rejected. If the first response is lost before ticket consumption, a retry preserves `sessionId`, atomically rotates the credential generation, invalidates the prior unconsumed ticket, and returns `rotated_unconsumed` with only the new credential. If a ticket was consumed, creation retry returns `existing_consumed` plus current session status without any raw credential, and the client uses explicit authenticated reconnect. Contract tests assert that this branch cannot serialize `transport`, `ticket`, `controlTicket`, or `ephemeralCredential`. Reconnect serializes generation/epoch rotation; concurrent attempts elect the latest committed generation and revoke every predecessor.

## Client-to-Gateway frames

Every JSON control frame is `VoiceFrameCommon & payload`, where common fields are `{contractVersion: 1, sessionId, epoch, sequence}`. `sequence` is monotonically increasing within the current epoch. Payload examples below omit no required common identity because the intersection supplies it.

```ts
type AudioFormat = {
  codec: "pcm_s16le" | "pcm_f32le" | "opus";
  sampleRateHz: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
  channels: 1 | 2;
  frameDurationMs: number;
};

type VoiceOutputAudioFormat = Omit<AudioFormat, "frameDurationMs">;

type VoiceFrameCommon = {
  contractVersion: 1;
  sessionId: VoiceSessionId;
  epoch: number;
  sequence: number;
};

type VoiceClientFrame = VoiceFrameCommon & (
  | { type: "client.ready"; audio: AudioFormat; capabilities: ClientMediaCapabilities }
  | { type: "capture.start"; turnId: string; mode: "hands_free" | "push_to_talk" }
  | { type: "capture.stop"; turnId: string }
  | { type: "capture.audio"; turnId: string; timestampMs: number; data: string }
  | { type: "session.pause" }
  | { type: "session.resume" }
  | { type: "session.end"; reason: "user" | "surface_closed" | "sign_out" }
  | { type: "response.interrupt"; responseId: string; playedThroughMs: number }
  | { type: "generation.cancel"; responseId: string }
  | { type: "action.cancel"; actionId: string }
  | { type: "playback.segment_played"; responseId: string; segmentId: string; playedThroughMs: number; deliveryRevision: number }
  | { type: "device.changed"; inputDeviceId?: string; outputDeviceId?: string }
  | { type: "heartbeat"; timestampMs: number }
);
```

Binary audio frames may replace base64 JSON after transport negotiation. They retain the same bounded session, epoch, turn, sequence, and timestamp semantics.

## Gateway-to-client frames

```ts
type VoiceServerFrame = VoiceFrameCommon & (
  | { type: "session.state"; state: VoiceSessionState; reason?: SafeVoiceReason }
  | { type: "session.resumed"; state: VoiceSessionState; reason?: SafeVoiceReason }
  | { type: "transcript.provisional"; turnId: string; revision: number; text: string }
  | { type: "transcript.final"; turnId: string; finalityId: string; canonicalTurnId?: string; canonicalQueuedTurnId?: string; localOrder: number; text: string }
  | { type: "transcript.correction"; turnId: string; finalityId: string; revision: number; text: string }
  | { type: "capture.completed"; turnId: string; outcome: "empty" | "failed" }
  | { type: "response.started"; responseId: string; runId: string }
  | { type: "response.audio"; responseId: string; segmentId: string; startMs: number; data: string; format?: VoiceOutputAudioFormat }
  | { type: "response.audio_end"; responseId: string; segmentId?: string; generatedDurationMs: number }
  | { type: "response.interrupted"; responseId: string; effectiveThroughMs: number }
  | { type: "operation.status"; runId: string; label: string; state: CanonicalOperationState; operationId?: string }
  | { type: "action.cancel_result"; actionId: string; outcome: "cancelled" | "requested" | "already_terminal" | "unavailable" | "unknown" }
  | { type: "transport.going_away"; retryAfterMs: number; reconnectAllowed: boolean }
  | { type: "session.error"; code: SafeVoiceErrorCode; retryable: boolean; recovery: VoiceRecoveryAction }
  | { type: "heartbeat.ack"; timestampMs: number }
);
```

`transcript.final` requires either `canonicalTurnId` or `canonicalQueuedTurnId`. A reconnect commits a new epoch before transport attachment; the replacement transport receives `session.resumed`, not an epoch-rotated `session.state`. `generation.cancel` targets the current canonical response/run, while `action.cancel` targets a qualified canonical action and must not be represented as local playback interruption. `action.cancel` always receives an `action.cancel_result` ack unless the session has no run-control port: `cancelled` means the operation reached `cancelled`, `requested` means a `running`/`outcome_unknown` operation recorded `cancellationRequested` (the in-flight effect is not interrupted), `already_terminal` means it finished first, and `unavailable` also surfaces a `session.error` (`unsupported_surface`, non-retryable — the deployment has no run-control port); `unknown` is reported by the ack alone so a live session is not falsely presented as failed, while a thrown cancellation additionally emits a retryable `chat_unavailable` error. `operation.status` may carry `operationId` so clients can correlate status with a cancellable `actionId` from canonical detail `operations`.

Durable assistant text, tool activity, approvals, and terminal results still arrive through the canonical Chat event stream. The voice channel may carry a bounded operation label for immediate spoken/UI feedback but cannot replace canonical activity state.

## Canonical admission decision table

At `capture.start`, the session snapshots canonical selection, interaction mode, permission mode, execution root, memory policy, Chat revision, and local turn order. At finalization it refreshes canonical state and applies this table with the same stable request identity:

| Condition | Admission behavior |
| --- | --- |
| No active run; base revision current | Admit ordinary canonical turn |
| Revision advanced without semantic conflict | Refresh revision, preserve frozen policy/request identity, admit once |
| Active assistant generation interrupted by this turn and run cancellation succeeds | Wait for terminal cancellation, refresh revision, admit ordinary turn |
| Active run cannot safely cancel, or tool/approval/input remains active | Use canonical queue when permitted; otherwise reject with visible recovery |
| Selected route explicitly supports canonical steering and user chose steer | Use canonical steering; never emulate steering in voice code |
| Typed turn races final speech | Shared canonical admission serialization and accepted local request order decide; voice does not overwrite or bypass typed input |
| Provider finals arrive out of order | Reorder by local capture order and provider item identity before admission |
| Duplicate final | Return prior admission outcome; do not create another turn |
| Empty or truncated final | Do not execute; keep editable/retryable transcript state |
| Correction after admission | Annotate provenance/presentation only; user correction is a new explicit turn |

Session-only is not supported in this delivery: capability reports `sessionOnly: "unsupported"`, and session creation with `memoryMode: "session_only"` is rejected. If it is qualified later, its policy must apply to spoken and typed turns admitted while the session owns the Chat and be carried through send, queue, steering, adapters and tools rather than inferred from session UI.

## Delivery acknowledgement and checkpoint contract

- Before first playback, create an idempotent canonical `pending` delivery record independent of active-run status.
- Every synthesis segment maps to canonical assistant text start/end offsets. An acknowledgement may advance only to the end of that exact segment and only for the current epoch/revision.
- Completion/interruption writes a terminal state. A crash or missing final acknowledgement leaves the record `unknown`; unknown never implies fully heard.
- Native harness checkpoint eligibility includes canonical context revision, delivery-context revision, and memory policy. Partial/unknown delivery invalidates checkpoints that cannot be updated delivery-aware.
- The next spoken or typed turn either rebuilds from Matrix-owned effective history or fails closed for that harness.

## Canonical action capability contract

Voice action eligibility is derived from canonical harness/tool capabilities:

- normalized tool and schema identity;
- normalized argument digest bound to approval;
- enforceable policy before side effects;
- stable operation/idempotency identity and reconciliation;
- truthful cancellation granularity (`none`, `run`, `tool`).

The voice layer never supplies missing enforcement. Unsupported routes degrade to conversation-only or safe reads. Stop speaking, cancel generation, and cancel action are separate commands and statuses.

Consequential execution is constrained Codex with five bounded app tools; delegation is disabled, non-Codex frozen action policies fail closed, and canonical Codex native input/approval delivery is unavailable. Run-level cancellation exists. Targeted `action.cancel` is wired end to end: the WS frame reaches `CanonicalActionAuthority.cancelById` (owner+chat scoped, run id resolved from the operation row), `action.cancel_result` reports the truthful outcome, and the canonical HTTP route `POST /api/chats/:chatId/actions/:actionId/cancel` offers the same semantics to typed surfaces. Cancellation granularity stays `run`-level: a `requested` outcome does not interrupt an in-flight effect.

Tool return JSON is not itself shell authority. `matrix_open_app`, file-apply artifacts, `outcome_unknown` and reconciliation results must become bounded canonical navigation/resource/activity records. Aoede may open only those validated projected records, and both Web Canvas and Web Desktop must prove the resulting destination behavior. Arbitrary `tool.output` text is never parsed into a navigation or filesystem command.

## State contract

```ts
type VoiceSessionState =
  | "requesting_permission"
  | "connecting"
  | "listening"
  | "thinking"
  | "using_tool"
  | "speaking"
  | "paused"
  | "reconnecting"
  | "restoring"
  | "failed"
  | "ending"
  | "ended";
```

Clients render labels from this bounded state. They do not infer `thinking` from silence, `using_tool` from elapsed time, or success from a newly visible app.

## Safe error and recovery contract

```ts
type SafeVoiceErrorCode =
  | "permission_denied"
  | "input_unavailable"
  | "output_unavailable"
  | "connection_failed"
  | "connection_lost"
  | "provider_unavailable"
  | "session_limit_reached"
  | "usage_limit_reached"
  | "audio_backpressure"
  | "chat_unavailable"
  | "session_conflict"
  | "unsupported_surface"
  | "internal_failure";

type VoiceRecoveryAction =
  | "request_permission"
  | "choose_input"
  | "choose_output"
  | "retry_connection"
  | "continue_in_chat"
  | "start_new_session"
  | "contact_support"
  | "none";
```

Server logs use correlation/session IDs and typed internal causes. Client errors never contain raw provider messages or secrets.

## Validation and resource limits

- Validate path IDs and every JSON frame with strict Zod schemas.
- Reject frames for the wrong session, principal, epoch, or non-monotonic sequence.
- Set route `bodyLimit` on every mutation, including DELETE.
- Limit JSON frame bytes, audio frame bytes, queued audio milliseconds, transcript length, reconnect attempts, tool depth/count, session duration, idle duration, and concurrent sessions.
- Pause capture or fail explicitly on backpressure; never permit unbounded queues.
- Heartbeat and inactivity timers are bounded and disposed on every terminal path.
- External provider calls and token creation use explicit timeouts.
- Raw audio, transcript content, provider credentials, and exact tool arguments are excluded from ordinary logs and metrics.
- Fixture-only authentication, provider catalogs, policy, and adapter injection are compile/test composition and cannot be selected by production requests or environment input.

## Integration wiring

1. Gateway server construction receives the existing canonical Chat runtime and a voice provider registry; production construction rejects simulator registration.
2. Voice session routes are registered after canonical Chat and authenticated speech/platform clients are initialized.
3. Session creation verifies principal, Chat write access, policy, authoritatively probed managed-speech readiness, provider health, concurrency, and budget before minting transport credentials.
4. The media adapter emits provisional/final speech events to the session engine.
5. Final speech is ordered and admitted once through canonical Chat using the decision table, frozen policy snapshot, and stable request ID.
6. Canonical run events drive the synthesis queue and normal Chat event stream.
7. Tool proposals and approvals use existing canonical services; the voice channel never executes them directly.
8. Shutdown stops admission, drains/cancels bounded sessions, closes providers, releases capture channels, and then closes canonical/runtime dependencies in existing order.

## Failure and recovery invariants

- A reconnect atomically advances the transport epoch before the replacement connection can mutate session state.
- Late frames from prior epochs are ignored and counted.
- Native provider resumption is used only from an acknowledged resumable checkpoint.
- Otherwise the provider projection is rebuilt from canonical Chat summary, recent turns, pending commitments, and the acknowledged delivery projection; unknown/unacknowledged output is excluded conservatively.
- Non-idempotent actions are reconciled or marked outcome unknown; they are never automatically replayed.
- Ending is idempotent even when provider shutdown, transport close, and client DELETE race.
- Cleanup failure is logged and surfaced safely without leaving the session admissible.
- Post-run delivery writes use their own idempotent repository transaction and never reopen or mutate terminal run execution state.

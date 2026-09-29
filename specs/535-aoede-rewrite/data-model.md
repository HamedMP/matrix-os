# Aoede Voice Data Model

## Ownership rules

- Canonical Chat messages, runs, activities, approvals, and operation results are durable owner data in the existing owner-local PostgreSQL authority.
- Voice session runtime, provider connection state, audio queues, and provisional transcripts are bounded ephemeral state.
- Raw audio is not durable by default.
- Provider credentials and platform usage reservations remain platform-owned operational data; they never become owner Chat content.
- No new voice-only memory or transcript store is introduced.

## VoiceSession

One bounded realtime interaction attached to exactly one canonical Chat.

| Field | Meaning | Persistence |
| --- | --- | --- |
| `sessionId` | Stable opaque session identifier | Ephemeral operational metadata; may be referenced by canonical events |
| `chatId` | Canonical owning Chat | Required durable relation through admitted turns |
| `ownerId` / runtime principal | Authenticated owner/runtime binding | Request/session authority only; never client-asserted |
| `status` | Session lifecycle state | Ephemeral; terminal reason may be a canonical activity |
| `transportEpoch` | Monotonic active connection generation | Ephemeral |
| `providerAdapterId` / version | Selected adapter and conformance version | Bounded operational metadata and diagnostics |
| `inputDevice` / `outputDevice` | Client-local selected devices | Owner presentation preference; never platform content |
| `turnMode` | Hands-free or push-to-talk | Owner preference/session override |
| `memoryMode` | Ordinary or session-only | Immutable canonical run-policy snapshot for every owned spoken/typed turn |
| `limits` | Duration, idle, queue, tool, context, and budget bounds | Policy snapshot for audit/diagnostics |
| `createdAt`, `lastActivityAt`, `endedAt` | Bounded lifecycle timestamps | Operational metadata |
| `endReason` | User, permission, device, network, provider, limit, or shutdown reason | Safe terminal diagnostic |

### State transitions

```text
idle
  → requesting_permission
  → connecting
  → listening ↔ thinking ↔ using_tool ↔ speaking
  → paused ↔ listening
  → reconnecting → restoring → listening|thinking|speaking
  → failed
  → ending → ended
```

Rules:

- Only the current transport epoch may transition active state.
- `failed` can transition to `connecting` only through explicit retry.
- `ending` is idempotent and rejects new capture, turns, and actions.
- Every terminal path releases capture, playback, provider, timers, queues, and one-time credentials.

## VoiceTurn

One user-to-assistant conversational turn mapped to a canonical Chat turn/run.

| Field | Meaning |
| --- | --- |
| `turnId` | Stable voice turn identity |
| `sessionId` / `transportEpoch` | Origin and stale-event fence |
| `localOrder` | Monotonic capture order independent of provider completion order |
| `providerItemId` / `providerCommitId` | Deduplication and reordering identity |
| `canonicalTurnId` / `runId` | Canonical Chat identity after admission |
| `phase` | Capturing, finalizing, admitted, generating, speaking, interrupted, complete, failed |
| `provisionalTranscript` | Mutable recognition hypothesis; never durable Chat truth |
| `finalTranscript` | Final user transcript admitted once to Chat |
| `startedAt`, `speechEndedAt`, `admittedAt`, `completedAt` | Latency and lifecycle timestamps |
| `interruption` | Optional interruption boundary and cause |
| `admissionSnapshot` | Base revision, selected route, interaction/permission mode, execution root, and memory policy frozen for admission |
| `admissionOutcome` | Sent, queued, steered, cancelled-then-sent, rejected, or empty |

Invariants:

- A final transcript is admitted to canonical Chat at most once using a stable client request ID.
- Provisional transcript never creates an independently executable Chat turn.
- Typed input during voice uses normal canonical Chat admission and is visible to the session context projector.
- Provider completion order never overrides `localOrder`; duplicates and late corrections reuse the same turn identity.
- Once admitted, a correction may annotate transcript provenance but cannot mutate the executed prompt or create another run.

## CanonicalVoiceDelivery

Tracks what assistant output the user actually heard. It is a canonical, idempotent post-run record with its own repository write path; it does not use active-run-only activity appends and never reopens execution.

| Field | Meaning |
| --- | --- |
| `responseId` | Canonical response/generation identity |
| `runId` / `messageId` | Canonical run and visible assistant message relation |
| `state` | Pending, playing, complete, interrupted, or unknown |
| `revision` | Monotonic update identity for idempotent conditional writes |
| `segments` | Ordered segment IDs with canonical text start/end offsets and audio duration |
| `acknowledgedSegment` | Last completely played segment; partial segments remain unacknowledged |
| `deliveredThroughMs` | Diagnostic audio delivery boundary |
| `playedThroughMs` | Client acknowledgement bounded by the last whole segment |
| `effectiveTextEnd` | Conservative canonical text offset used in later model context |
| `transportEpoch` | Epoch allowed to advance delivery state |
| `terminalReason` | Complete, interrupted, ended, crashed, acknowledgement lost, or unknown |

Invariants:

- Insert `pending` before the first audio segment is eligible for playback.
- `playedThroughMs ≤ deliveredThroughMs`, but only a whole acknowledged segment advances `effectiveTextEnd` unless verified word alignment exists.
- Acknowledgements are idempotent and monotonic; stale epochs and older revisions cannot advance state.
- Crash or lost acknowledgement leaves pending/playing delivery unknown and conservatively excludes every unacknowledged segment from later model context.
- The full generated assistant message may remain visible in Chat with an Interrupted/Delivery unknown marker while model context uses `effectiveTextEnd`.
- Records contain no audio bytes.

## CanonicalVoiceRunPolicy

An immutable policy snapshot attached to every spoken or typed canonical turn admitted while the voice session owns the Chat.

| Field | Meaning |
| --- | --- |
| `memoryMode` | Ordinary or session-only |
| `nativeCheckpointPolicy` | Reusable, disposable, or invalidated |
| `memoryTools` | Allowed canonical memory tool identities |
| `providerRetentionClass` | Verified selected-route retention behavior |
| `deliveryContextRevision` | Canonical delivery projection used to build model context |
| `actionCapabilityRevision` | Canonical action/approval matrix used for admission |

Session-only requires disposable native state, memory tools disabled, and a selected route whose provider retention behavior satisfies policy. If any requirement is unsupported, the capability is unavailable rather than prompt-enforced.

## ResumeCheckpointEligibility

Extends canonical resume selection with delivery-aware eligibility.

| Field | Meaning |
| --- | --- |
| `checkpointId` / native session ID | Existing canonical/native checkpoint |
| `canonicalContextRevision` | Chat revision represented by the checkpoint |
| `deliveryContextRevision` | Heard-history projection represented by the checkpoint |
| `memoryPolicy` | Policy under which the checkpoint was created |
| `eligibility` | Eligible, invalidated by interruption, invalidated by policy, or unsupported |

Any partial/unknown delivery or session-only policy mismatch invalidates a checkpoint that cannot be updated safely. The next spoken or typed turn rebuilds from Matrix-owned projected history or fails closed for that harness.

## TransportLease

The currently authorized client connection for one session.

| Field | Meaning |
| --- | --- |
| `epoch` | Monotonic connection generation |
| `ticketDigest` | One-time ticket verifier; raw ticket is never persisted or logged |
| `credentialGeneration` | Monotonic mint/rotation identity |
| `state` | Minted, consumed, superseded, expired, or revoked |
| `connectedAt`, `expiresAt` | Bounded lifetime |
| `lastInboundSequence`, `lastOutboundSequence` | Gap/duplicate detection |
| `resumeHandle` | Provider-native handle when supported and currently resumable |

Only one transport lease may mutate a session. Create retry before consumption rotates the credential and revokes its predecessor while preserving the session. Reconnect serializes credential rotation and epoch selection; the latest committed generation wins and atomically supersedes prior credentials and epochs.

## ProviderSessionProjection

A disposable projection of canonical state for one provider connection.

| Field | Meaning |
| --- | --- |
| `adapterId`, `adapterVersion` | Exact conformance target |
| `providerSessionId` | Diagnostic provider identity; never a Chat identity |
| `capabilities` | Transport, transcript, VAD, synthesis, cancellation, resume, and usage support |
| `contextRevision` | Canonical Chat revision used to build the projection |
| `summary` | Durable Matrix-generated bounded context summary |
| `recentTurns` | Bounded verbatim canonical context |
| `pendingCommitments` | Approved/running/unknown actions and unresolved user intent |
| `nativeResumeHandle` | Optional optimization, not sole recovery state |

Provider projections may be discarded and rebuilt from canonical Matrix state.

## ToolInvocation

Voice uses the existing canonical Chat activity and approval model. The voice layer adds no independent execution authority.

```text
proposed
  → approval_pending → approved
  → running
  → succeeded | failed | cancelled | outcome_unknown
```

Required identity includes canonical call ID, tool/schema version, normalized argument digest, idempotency key, originating turn/run, deadline, risk classification, and approval record. A changed argument digest invalidates approval.

These fields are canonical prerequisites, not guarantees of every current harness. Each harness/tool route declares conversation only, safe reads, or canonical actions; only canonical actions may execute consequential work by voice. Cancellation separately declares run-level, tool-level, or non-cancellable support.

## VoiceCapability

A safe projection used to decide whether to show or enable voice.

| Field | Meaning |
| --- | --- |
| `status` | Available, unavailable, or degraded |
| `surface` | Web Canvas, Web Desktop, Electron Desktop, or future native surface |
| `transportModes` | Supported relayed and/or direct media paths |
| `turnModes` | Hands-free and/or push-to-talk |
| `supportsInterruption` | Truthful adapter/session interruption capability |
| `resume` | Delivery-aware, rebuild-only, or unsupported |
| `sessionOnly` | Enforced or unsupported for the selected route |
| `actionMode` | Conversation only, safe reads, or canonical actions |
| `actionCancellation` | None, run, or tool granularity |
| `supportsInputSelection`, `supportsOutputSelection` | Truthful surface/device capabilities |
| `limits` | Safe user-visible duration and usage bounds |
| `unavailableReason` | Bounded recovery-oriented reason code |

The client must not infer capability from the presence of an API key, a route, or a stale saved preference.

## VoicePreferences

Owner-controlled presentation and device preferences.

- Preferred input device identifier, stored only where the platform permits safely.
- Preferred output device identifier where supported.
- Hands-free or push-to-talk mode.
- Interruption sensitivity where supported.
- Voice selection and playback speed.
- Captions/transcript visibility.
- Reduced motion derives from OS/user accessibility settings rather than a conflicting voice-only value.

Preferences never grant microphone permission or provider access and must degrade safely when a device disappears.

## SimulatorScenario

A deterministic test fixture, not production state.

| Field | Meaning |
| --- | --- |
| `scenarioId` / `version` | Stable fixture identity |
| `initialChat` | Canonical seed messages and activities |
| `timeline` | Virtual-time microphone, provider, transport, tool, permission, and device events |
| `expectedJournal` | Canonical event and terminal-state assertions |
| `expectedPlayback` | Generated/delivered/played/interrupted assertions |
| `expectedResources` | Capture, socket, timer, queue, and provider cleanup assertions |

Fixtures contain no private recordings or provider credentials.

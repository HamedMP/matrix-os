# Aoede: standalone Matrix workspace assistant

**Branch:** feat/aoede-rewrite
**Product correction:** 2026-09-30. This specification supersedes the former active-Chat voice-mode direction. Local implementation and deterministic validation are authorized; release qualification is not.

## Product and ownership

Aoede is a compact, polished Jarvis-style workspace assistant opened from a dedicated launcher icon or the global Matrix command palette. Both entry points reveal/focus/toggle the same shell-owned singleton. It works with Chat closed. It is not a Chat dock, message list, composer, transcription demo, full-page Chat or another reasoning/action backend.

Presentation and media lifecycle are independent of Chat UI. Canonical Matrix Chat remains the sole authority for transcript/context, model selection, admission/queue/steer, tools/tasks/delegation, approvals/input, activity/artifacts/results, permissions/memory, cancellation/recovery, history/export/deletion. Every finalized spoken turn follows the exact ordinary canonical admission → orchestrator → provider adapter → tool/task path.

## User scenarios and acceptance

### 1. Launch without Chat

From Web Canvas, Web Desktop or Electron Desktop, the icon and palette open one assistant with literal Idle status, microphone off, scope and readiness. Racing launches create at most one backing conversation and no media stream. Launch/focus/restore never requests microphone permission. Start requires an explicit gesture and permission rationale. Switching or closing Chat neither retargets nor ends Aoede. Focus returns to the invoking workspace control, not a Chat composer.

### 2. Continue or start fresh

Bootstrap resolves the owner's assistant conversation for the immutable runtime and stable workspace/project scope. Continue after End or shell reload reuses that canonical conversation, but not an ephemeral voice session. New conversation is an explicit operation with idempotent request identity. Access loss/deletion stops media, reports unavailable and requires explicit new-conversation intent; it never silently selects another Chat. History opens the exact backing record only when requested.

### 3. Discuss and act in the workspace

Qualified providers can discuss/search, inspect bounded workspace/app state, look up/open apps, and propose approved app creation/modification through canonical tools. Aoede renders canonical approval previews, clarification controls, task/delegation progress, artifacts/results and terminal outcomes without opening Chat. Unsupported consequential publish/spend/delete/permission/network/filesystem operations fail closed. A mode never implies every tool qualifies.

### 4. Control independent lifecycles

Pause stops capture; Stop speaking stops local/synthesis audio and records conservative delivery, not external work. Cancel generation requests canonical whole-run cancellation. Cancel action/task acts only at proven granularity; non-cancellable or ambiguous work remains running/outcome_unknown. Light dismissal stops capture/playback, preserves canonical work and makes it discoverable on reopen. End releases media/session but retains conversation and operations.

### 5. Recover truthfully

Lost responses reconcile stable creation/request identity. Reconnect rotates tickets/epochs, adopts durable delivery and cannot replay effects. Gateway restart is not transport reconnect: bootstrap reloads canonical state and requires explicit media start. Interrupted spoken and typed continuation exclude unheard suffixes and unsafe native checkpoints. Permission/device/connection/model/funding/policy failures offer bounded local recovery controls, not compulsory Chat navigation.

## Requirements

| ID | Requirement |
| --- | --- |
| AO-01 | Icon and global palette converge on one shell-level singleton across app/window/presentation switches. |
| AO-02 | No ChatApp or Chat-mounted component owns Aoede or remains hidden to control it. |
| AO-03 | Idempotent backing-conversation bootstrap binds authenticated owner, runtime and workspace/project scope; End/reload continues; New is explicit. |
| AO-04 | Runtime/account/scope changes fence async work and release old media; access/deletion never silently rebinds. |
| AO-05 | No microphone access on layout/state restoration or open/focus; explicit Start plus rationale only. |
| AO-06 | Canonical typed/spoken admission, queue, dequeue, steering, retry and actual dispatch share one server-owned policy. |
| AO-07 | Capability is intersection of speech, harness, tool inventory, permission/scope, approval, reconciliation, cancellation, account/funding/readiness and surface. |
| AO-08 | conversation_only structurally executes no actions; safe_reads executes only individually verified bounded tools; canonical_actions executes individually qualified consequential tools only. |
| AO-09 | Native commands/writes/network/plugins/inherited config/delegation cannot escape policy; prompts are not enforcement. |
| AO-10 | Exact approval binds owner/Chat/run/action/tool/schema revision/validated normalized arguments/digest/policy. Mutation invalidates it. |
| AO-11 | Canonical authorization is atomically revalidated/consumed immediately before dispatch; stable operation identity persists first. Typed/delegated callers use the same authority. |
| AO-12 | Unique claim, retry, timeout, crash/result persistence and downstream reconciliation are defined; ambiguous effects become outcome_unknown and never auto-replay. |
| AO-13 | Delegation propagates policy and operation identity; provider subagent activity is not falsely advertised as a universal task service. |
| AO-14 | Stop speaking, Cancel generation, Cancel action/task, dismissal and End are distinct with truthful granularity. |
| AO-15 | Canonical activities/approvals/input/task/artifact/result projections are usable without Chat UI and survive media dismissal. |
| AO-16 | Stable finality/request identity, local capture ordering, canonical revision and queue semantics prevent duplicate turns/runs/effects. |
| AO-17 | Durable non-empty pending manifest precedes playback; contiguous acknowledgements, epoch/revision fencing, interrupted/unknown states preserve heard context. |
| AO-18 | Native resume uses checkpoint provenance and retained canonical history; lookup failure fails closed for spoken and typed continuations. |
| AO-19 | Session-only stays unsupported until provider retention/native state/tools/typed/delegated/restart paths all enforce it. |
| AO-20 | Platform Speech is sole production credential/funding/policy authority for microphone → managed STT → canonical execution → managed TTS → speaker. |
| AO-21 | Synthesis streams before complete payload; provisional recognition cadence is bounded and honestly disclosed; batch behavior never masquerades as streaming. |
| AO-22 | Cleanup bypasses ordinary admission exhaustion, failed DELETE stays bounded/retryable, transport loss immediately stops queued playback, AudioContext resume rejection is observed. |
| AO-23 | Permission/device loss releases media and offers recovery; late create/reconnect/device work is identity-fenced. |
| AO-24 | Strict reconnect schema, accepted resumed epoch, structured SafeVoiceError and one-time ticket rotation are enforced. |
| AO-25 | Browser Origins and speech enablement persist on parity creation/update; Electron qualification does not globally trust Origin:null or weaken CSP/privileges. |
| AO-26 | Shared compact presentation has ambient visual plus accessible literal Listening/Thinking/Using tool/Speaking/Paused/Reconnecting/Failed/Ended labels, mic state and scope. |
| AO-27 | Captions are bounded current/provisional utterance/response; no Chat list/composer. Clarification-only fields are bounded. |
| AO-28 | PTT, pause/resume, Stop speaking, End, qualified cancellation, approval/input/result controls and progressive device/settings are available. |
| AO-29 | Keyboard/focus/screen-reader/reduced-motion/high-contrast/zoom work on all three surfaces. |
| AO-30 | Electron host is nonmodal/non-overlapping and does not hold a modal lease that detaches native views. |
| AO-31 | Legacy vocal-profile data is audited non-destructively; no silent import/delete or second transcript/memory store. |
| AO-32 | Deterministic fixtures fake both speech and canonical model/action boundaries; environment-selected simulator eligibility bypass is forbidden. |
| AO-33 | Disposable real Postgres proves locking/concurrency/recovery claims; PGlite is not process-crash evidence. |
| AO-34 | Requirement/evidence matrix records implementation, exact checks and unresolved gates before completion claims. |

## Security and resource constraints

Existing principal/auth/owner-controlled PostgreSQL boundaries apply. Bootstrap mutations and voice routes require bounded bodies and strict schemas, immutable identity, explicit timeouts and scoped authorization. Client identity/scope/model/tool choices never grant authority. All registries, captions, queues, operations, reconnect/cleanup attempts and subscribers are bounded with eviction/shutdown drains. Provider secrets remain platform-only; operational speech tokens are runtime-bound, never exposed to renderers. Logs/artifacts contain no secrets, raw audio, private transcript or sensitive arguments. No shared database/infrastructure mutation is authorized.

## Success and delivery states

A: implemented locally. B: deterministically validated with exact evidence and omissions. C: product/release qualified. All unblocked A/B requirements must be implemented; disabled actions or fixture-only behavior do not constitute completion.

Deterministic acceptance includes closed-Chat singleton racing launches; same typed/spoken orchestrator; native/delegated/queue/retry/steer escape attempts; approval mutation; duplicate/concurrent dispatch; crash-after-effect-before-result; no effect replay on reconnect; outcome_unknown; cancellation races; delegated policy; interrupted asymmetric context; cleanup exhaustion/retry; media/device failures; lost response/stale epochs; rendered permission/listening/thinking/tool/speaking/approval/input/progress/reconnect/failure on all three fixture surfaces.

C requires separate authorization/evidence for managed STT → actual Codex → managed TTS, real mic/speaker, packaged Electron, production parity provision/restart, provider account/retention/funding review, measured latency/interruption and accessibility/usability. No push/PR/merge/deploy/full runtime/paid provider is authorized. Public docs in FinnaAI/matrix-os-site are a later separately authorized release deliverable.

## Non-goals

Wake words/background listening/menu-bar app/OS-global shortcuts, unrestricted shell/desktop control, provider-owned reasoning, Aoede tools/queues/approval/memory stores, telephony, onboarding rewrite, voice cloning, emotion inference, audio recording and Native Mobile implementation.

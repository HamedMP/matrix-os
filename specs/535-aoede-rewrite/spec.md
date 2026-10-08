# Aoede: standalone Matrix workspace assistant

**Branch:** feat/aoede-product-rebuild. **Base:** `1eafe737b2668a84592eacadb307707e094eb1a7`. **Reviewed checkpoint:** `553fff73d`.
**Product correction:** 2026-09-30. This specification supersedes the former active-Chat voice-mode direction. Local implementation and deterministic validation are authorized; release qualification is not.
**Scope correction:** 2026-09-30. Target surfaces for this delivery are Web Canvas and browser Web Desktop only. Electron Desktop is explicitly out of scope and deferred to a separate follow-up; the `electron_desktop` protocol enum value predates this work and remains for backward compatibility only.

## Product and ownership

Aoede is a compact, polished Jarvis-style workspace assistant opened from a dedicated launcher icon or the global Matrix command palette. Both entry points reveal or focus the same shell-owned singleton; invoking an entry point never hides it. It works with Chat closed. It is not a Chat dock, message list, composer, transcription demo, full-page Chat or another reasoning/action backend.

Presentation and media lifecycle are independent of Chat UI. Canonical Matrix Chat remains the sole authority for transcript/context, model selection, admission/queue/steer, approvals/input, activity/artifacts/results, permissions/memory, cancellation/recovery, history/export/deletion. Every finalized spoken turn must enter ordinary canonical admission and run ownership. Tool, task and delegation capability is not inherited by assertion: each provider path must prove that it can carry the frozen Aoede policy and use canonical authorization without an alternate execution layer.

At reviewed checkpoint `553fff73d`, the only qualified consequential path is constrained Codex with five bounded owner-app tools (list, inspect, search, open and approval-gated file apply). Delegation is disabled, non-Codex frozen action policies fail closed, and provider-native input/approval delivery on canonical Codex runs is unavailable. Run activity can be projected, but it is not a universal task/delegation service. These are implementation facts, not the final product ceiling.

### Minimum delivery capability

This web delivery is not complete by merely marking unsupported paths unavailable. It must provide, without opening Chat:

- a standalone canonical provider/model chooser and current-selection display using the existing Chat catalog, with constrained Codex available as the required qualified action provider and local retry/change-selection recovery when a choice is unavailable;
- spoken multi-turn conversation, canonical history/Continue/New/View history, assistant speech, interruption and generation cancellation;
- the five bounded Codex app capabilities: list apps, inspect safe app files, search safe app source, open a validated app and propose an approval-gated bounded file batch;
- exact approval plus a bounded clarification/input interaction on that qualified path;
- durable activity, navigation, artifact, result, `outcome_unknown` and reconciliation presentation in Aoede and the backing history; and
- targeted cancellation where the canonical action is cancellable, with truthful running/non-cancellable/unknown states otherwise.

Additional providers, arbitrary native tools, broad delegated tasks and OS-wide control are follow-up qualifications, not loopholes for omitting this minimum.

## User scenarios and acceptance

### 1. Launch without Chat

From Web Canvas or browser Web Desktop, the icon and palette open one assistant with literal Idle status, microphone off, scope and readiness. Racing launches create at most one backing conversation and no media stream. Launch/focus/restore never requests microphone permission. Start requires an explicit gesture and permission rationale. Switching or closing Chat neither retargets nor ends Aoede. Focus returns to the invoking workspace control, not a Chat composer.

### 2. Continue or start fresh

Bootstrap resolves the owner's assistant conversation for the immutable runtime and stable workspace/project scope. The first open in a shell session starts a fresh canonical conversation (bootstrap intent `new`, idempotent by request identity) so the assistant never resumes a stale thread the user has forgotten; reopening after dismissal or End within the same shell session continues that conversation without a second bootstrap, and earlier conversations stay reachable through View history. New conversation remains an explicit operation with idempotent request identity. Access loss/deletion stops media, reports unavailable and requires explicit new-conversation intent; it never silently selects another Chat. History opens the exact backing record only when requested.

### 3. Discuss and act in the workspace

Qualified providers can discuss/search, inspect bounded workspace/app state, look up/open apps, and propose approved app creation/modification through canonical tools. The completed product must render canonical approval previews, qualified clarification controls, activity/task progress, navigation/artifacts/results, reconciliation outcomes and terminal states without opening Chat. Each of those flows requires real end-to-end evidence on the qualified provider path; component projection or returned tool JSON alone is insufficient. Delegation remains fail-closed until policy propagation and enforcement are proven. Unsupported consequential publish/spend/delete/permission/network/filesystem operations fail closed. A mode never implies every tool qualifies.

### 4. Control independent lifecycles

Pause stops capture; Stop speaking stops local/synthesis audio and records conservative delivery, not external work. Cancel generation requests canonical whole-run cancellation. Cancel action/task acts only at proven granularity; non-cancellable or ambiguous work remains running/outcome_unknown. Light dismissal stops capture/playback, preserves canonical work and makes it discoverable on reopen. End releases media/session but retains conversation and operations.

### 5. Recover truthfully

Lost responses reconcile stable creation/request identity. Reconnect rotates tickets/epochs, adopts durable delivery and cannot replay effects. Gateway restart is not transport reconnect: bootstrap reloads canonical state and requires explicit media start. Interrupted spoken and typed continuation exclude unheard suffixes and unsafe native checkpoints. Permission/device/connection/model/funding/policy failures offer bounded local recovery controls, not compulsory Chat navigation.

## Requirements

| ID | Requirement |
| --- | --- |
| AO-01 | Icon and global palette converge on one shell-level singleton across app/window/presentation switches. |
| AO-02 | No ChatApp or Chat-mounted component owns Aoede or remains hidden to control it. |
| AO-03 | Idempotent backing-conversation bootstrap binds authenticated owner, runtime and workspace/project scope; first open per shell session starts fresh, reopen within the session continues, New is explicit. |
| AO-04 | Runtime/account/scope changes fence async work and release old media; access/deletion never silently rebinds. |
| AO-05 | No microphone access on layout/state restoration or open/focus; explicit Start plus rationale only. |
| AO-06 | Canonical typed/spoken admission, queue, dequeue, steering, retry and actual dispatch share one server-owned policy. |
| AO-07 | Capability is intersection of speech, harness, tool inventory, permission/scope, approval, reconciliation, cancellation, account/funding/readiness and surface. |
| AO-08 | conversation_only structurally executes no actions; safe_reads executes only individually verified bounded tools; canonical_actions executes individually qualified consequential tools only. |
| AO-09 | Native commands/writes/network/plugins/inherited config/delegation cannot escape policy; prompts are not enforcement. |
| AO-10 | Exact approval binds owner/Chat/run/action/tool/schema revision/validated normalized arguments/digest/policy. Mutation invalidates it. |
| AO-11 | Canonical authorization is atomically revalidated/consumed immediately before dispatch; stable operation identity persists first. Typed/delegated callers use the same authority. |
| AO-12 | Unique claim, retry, timeout, crash/result persistence and downstream reconciliation are defined; ambiguous effects become outcome_unknown and never auto-replay. |
| AO-13 | Delegation remains disabled until the existing canonical provider/task path propagates and enforces policy and operation identity; provider subagent activity is never advertised as a universal task service. |
| AO-14 | Stop speaking, Cancel generation, Cancel action/task, dismissal and End are distinct with truthful granularity. |
| AO-15 | Canonical activities/approvals/input/task/artifact/result projections are usable without Chat UI and survive media dismissal. |
| AO-16 | Stable finality/request identity, local capture ordering, canonical revision and queue semantics prevent duplicate turns/runs/effects. |
| AO-17 | Durable non-empty pending manifest precedes playback; contiguous acknowledgements, epoch/revision fencing, interrupted/unknown states preserve heard context. |
| AO-18 | Native resume uses checkpoint provenance and retained canonical history; lookup failure fails closed for spoken and typed continuations. |
| AO-19 | Session-only stays unsupported until provider retention/native state/tools/typed/delegated/restart paths all enforce it. |
| AO-20 | Platform Speech is sole production credential/funding/policy authority for microphone → managed STT → canonical execution → managed TTS → speaker. |
| AO-21 | Synthesis streams before complete payload. Provisional recognition is currently unavailable; any future cadence is bounded and honestly disclosed, and batch behavior never masquerades as streaming. |
| AO-22 | Cleanup bypasses ordinary admission exhaustion, failed DELETE stays bounded/retryable, transport loss immediately stops queued playback, AudioContext resume rejection is observed. |
| AO-23 | Permission/device loss releases media and offers recovery; late create/reconnect/device work is identity-fenced. |
| AO-24 | Strict reconnect schema, accepted resumed epoch, structured SafeVoiceError and one-time ticket rotation are enforced. |
| AO-25 | Browser Origins and speech enablement persist on parity creation/update; no qualification may globally trust Origin:null or weaken CSP/privileges. |
| AO-26 | Shared compact presentation has ambient visual plus accessible literal Listening/Thinking/Using tool/Speaking/Paused/Reconnecting/Failed/Ended labels, mic state and scope. |
| AO-27 | Captions are bounded current/provisional utterance/response; no Chat list/composer. Clarification-only fields are bounded. |
| AO-28 | PTT, persisted turn mode, input/output device selection, device-loss recovery, pause/resume, Stop speaking, End, qualified generation/action cancellation, approval/input/result controls and progressive settings are available. |
| AO-29 | Keyboard/focus/screen-reader/reduced-motion/high-contrast/zoom work on both browser surfaces (Web Canvas and Web Desktop). |
| AO-30 | Deferred — Electron Desktop host (nonmodal/non-overlapping, no modal lease detaching native views) is out of scope for this delivery and tracked as a separate follow-up. |
| AO-31 | Legacy vocal-profile data is audited non-destructively; no silent import/delete or second transcript/memory store. |
| AO-32 | Deterministic fixtures fake both speech and canonical model/action boundaries; environment-selected simulator eligibility bypass is forbidden. |
| AO-33 | Disposable real Postgres proves locking/concurrency/recovery claims; PGlite is not process-crash evidence. |
| AO-34 | Requirement/evidence matrix records implementation, exact checks and unresolved gates before completion claims. |
| AO-35 | Simulator registration is structurally rejected in production; an empty/discarding simulator can never advertise product availability. |
| AO-36 | Bounded managed STT and streaming-TTS readiness is authoritatively probed; configured-but-unready, timeout and unknown fail closed with safe status/reason. |
| AO-37 | Open-app and file-apply outcomes become canonical navigation/artifact/result records handled by both browser surfaces and retained in history, including outcome_unknown/reconciliation. |
| AO-38 | Deterministic composition proves both speech and canonical model/action boundaries are fake and uses standalone Aoede hosts with Chat closed on Web Canvas and Web Desktop. |
| AO-39 | Shared protocol prose and tests cover common frame identity, resume/correction, generation cancellation and action cancellation without drifting from authoritative schemas. |

## Security and resource constraints

Existing principal/auth/owner-controlled PostgreSQL boundaries apply. Bootstrap mutations and voice routes require bounded bodies and strict schemas, immutable identity, explicit timeouts and scoped authorization. Client identity/scope/model/tool choices never grant authority. All registries, captions, queues, operations, reconnect/cleanup attempts and subscribers are bounded with eviction/shutdown drains. Provider secrets remain platform-only; operational speech tokens are runtime-bound, never exposed to renderers. Logs/artifacts contain no secrets, raw audio, private transcript or sensitive arguments. No shared database/infrastructure mutation is authorized.

## Success and delivery states

A: implemented locally. B: deterministically validated with exact evidence and omissions. C: product/release qualified. All unblocked A/B requirements must be implemented; disabled actions or fixture-only behavior do not constitute completion.

Deterministic acceptance includes closed-Chat singleton racing launches; same typed/spoken orchestrator; production simulator rejection; authoritative readiness timeout/unready states; native/delegated/queue/retry/steer escape attempts; approval mutation; qualified clarification; duplicate/concurrent dispatch; crash-after-effect-before-result; no effect replay on reconnect; outcome_unknown/reconciliation projection; open-app navigation and file artifact handling; generation/action cancellation races; fail-closed delegation; persisted mode/device loss; interrupted asymmetric context; cleanup exhaustion/retry; media/device failures; lost response/stale epochs; and rendered permission/listening/thinking/tool/speaking/approval/input/progress/reconnect/failure on standalone Web Canvas and Web Desktop fixtures with Chat closed.

C requires separate authorization/evidence for managed STT → actual Codex → managed TTS, real mic/speaker, production parity provision/restart, provider account/retention/funding review, measured latency/interruption and accessibility/usability. Electron Desktop packaging/host qualification is not part of A, B or C for this delivery; it is deferred to a separate follow-up requiring its own authorization and evidence. No push/PR/merge/deploy/full runtime/paid provider is authorized. Public docs in FinnaAI/matrix-os-site are a later separately authorized release deliverable.

## Non-goals

Wake words/background listening/menu-bar app/OS-global shortcuts, unrestricted shell/desktop control, provider-owned reasoning, Aoede tools/queues/approval/memory stores, telephony, onboarding rewrite, voice cloning, emotion inference, audio recording, Electron Desktop host/packaging (deferred to a separate follow-up) and Native Mobile implementation.

# Implementation Plan: Matrix-Native Aoede Voice Mode

**Branch**: `feat/aoede-rewrite` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)
**Input**: Approved UX and architecture in [spec.md](spec.md), current repository ownership, and the external evidence consolidated in [research.md](research.md)

## Summary

Replace the provider-specific Aoede overlay with voice mode for canonical Matrix Chat. A bounded Gateway session engine turns streaming speech into canonical Chat turns, converts canonical assistant output into interruptible speech, and keeps provider transport disposable. Durable transcript, tools, approvals, operation state, memory, and recovery remain in existing Matrix authorities. Shared UI exposes literal state, persistent controls, provisional transcript, devices, recoverable errors, and canonical action presentation across Web Canvas, Web Desktop, and Electron Desktop.

Development starts with architecture-qualification spikes, a deterministic simulator, and a lightweight fixture. Before shared contracts freeze, the spikes must prove composed streaming cadence/latency, delivery-aware native-harness reconstruction, canonical action safety, enforceable session-only policy, and packaged Electron transport. Gemini Live remains only as a temporary legacy path while OpenAI, Gemini, and ElevenLabs component services are evaluated against the same conformance suite. The general-availability provider route is selected by measured quality, latency, reliability, cost, privacy, and platform support—not by the visual component library.

## Technical Context

**Language/Version**: TypeScript 5.9 strict ES modules; Node.js 24+; React 19
**Primary Dependencies**: Existing Hono Gateway, Zod 4 via `zod/v4`, canonical Chat repository/orchestrator/event stream, existing managed Platform Speech client/service, WebSocket/Web Audio APIs, Electron media permission boundary, Vitest, Playwright; provider SDKs added only after spike evidence
**Storage**: Existing owner-local PostgreSQL canonical Chat data plus a bounded canonical post-run delivery record and immutable run-policy/checkpoint metadata; bounded ephemeral Gateway session state; existing platform usage/reservation metadata; no new voice transcript database or voice-only memory file
**Testing**: Vitest unit/contract/integration with virtual time and deterministic speech/media plus fake harness/catalog/policy fixtures; PGlite for suitable repository tests; disposable PostgreSQL for locking/concurrency/crash tests; React Testing Library; Playwright; Electron E2E; real-provider conformance; final production-parity runtime check
**Target Platform**: Web Canvas, Web Desktop, Electron Desktop; shared semantic contract for later Native Mobile
**Project Type**: Existing multi-package OS with contracts, Gateway, platform speech control plane, shared React UI, web shell, and Electron renderer
**Performance Goals**: First spoken turn ready within 10 seconds including session setup; 95% of ordinary turns produce first audio or truthful named-operation status within 2 seconds; local interruption silences playback within 250 ms; no unbounded media/event queue
**Constraints**: One canonical Chat per session; no provider secrets in clients except constrained ephemeral credentials; no raw-audio persistence by default; exact action approvals; stale transport epochs cannot mutate state; explicit duration/idle/queue/context/tool/concurrency/cost limits; no routine VM requirement
**Scale/Scope**: One active voice session per admitted Chat/user policy in the initial release; app/workspace copilot capabilities only on qualified harness/tool routes; seven reviewable implementation layers plus separate public documentation PR; onboarding and Native Mobile presentation deferred

## Constitution Check

Pre-research result: **PASS**. Post-design result: **CONDITIONAL PASS** with no exception requested. Implementation contract freeze is blocked until the qualification gates below produce evidence; this satisfies the constitution's spike-before-spec requirement for undocumented SDK/runtime behavior.

| Principle | Plan evidence |
| --- | --- |
| I. Data belongs to its owner | Voice-derived durable content lives in owner-local canonical Chat/memory; raw audio is transient; provider/platform metadata is content-free and bounded; Chat export/delete remains authoritative. |
| II. AI is the kernel | The canonical Matrix Chat run remains reasoning and tool authority; native harness checkpoints are invalidated/rebuilt when delivery or memory policy diverges; speech providers perform bounded media roles or prove full canonical conformance before use. |
| III. Headless core, multi-shell | Contracts and Gateway engine are renderer-neutral; shared UI state feeds Web Canvas, Web Desktop, and Electron Desktop; Native Mobile can implement the same semantic contract later. |
| IV. Self-healing | Transport epochs, deterministic recovery, canonical reconstruction, outcome-unknown actions, and cleanup invariants prevent silent duplication or stale-session corruption. |
| V. Quality over shortcuts | Literal state, interruption, devices, permission recovery, accessibility, provider conformance, and production-parity evidence are release gates. |
| VI–VII. Ecosystem and tenancy | Initial actions are scoped to the owning Chat/workspace and existing app/tool authority; no client-asserted owner/runtime identity or unrestricted desktop control is added. |
| VIII. Defense in depth | [contracts/voice-session-api.md](contracts/voice-session-api.md) defines route auth, strict boundaries, safe errors, one-time tickets, resource limits, timeout policy, wiring, and recovery. |
| IX. TDD | Qualification spikes precede contract freeze; every delivery slice then begins with a failing contract, reducer, repository, adapter, route, component, or end-to-end scenario. |
| X. Worktree/PR/Greptile | Work is already in manual worktree `matrix-os-aoede-rewrite`; the implementation ships as a Graphite stack after Graphite is available, with current-head Greptile 5/5 and explicit approval before merge. |
| Documentation | A separate `FinnaAI/matrix-os-site` PR under `content/docs/` is a release deliverable. |

## Project Structure

### Documentation (this feature)

```text
specs/535-aoede-rewrite/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── voice-session-api.md
└── checklists/
    └── requirements.md
```

`tasks.md` is created only by the following `speckit-tasks` stage after this plan is approved.

### Source Code (repository root)

```text
packages/contracts/src/
  voice-session.ts                     # strict shared capability/session/frame schemas
  canonical-chat*.ts                   # delivery, admission, memory-policy, action capability contracts

packages/gateway/src/chat/
  database.ts                          # extend owner-local Chat schema in its current authority
  voice-delivery-repository.ts         # idempotent pending/heard/unknown post-run ledger
  turn-admission.ts                    # extend one authority for typed/voice queue/steer
  resume-checkpoint.ts                 # delivery-aware native checkpoint eligibility/rebuild
  run-memory-policy.ts                 # immutable durable/session-only propagation
  action-capabilities.ts               # approval digest/reconciliation/cancellation eligibility
  claude-provider-adapter.ts           # safe projection or fail-closed voice eligibility
  hermes-provider-adapter.ts           # safe projection or fail-closed voice eligibility

packages/gateway/src/voice-session/
  registry.ts                          # capped session admission, lookup, eviction, shutdown
  engine.ts                            # lifecycle, turn, interruption, reconnect, cleanup
  transport-ticket.ts                  # one-time path/principal/session-bound tickets
  playback-ledger.ts                   # segment acks mapped to text and canonical delivery writes
  context-projector.ts                 # bounded canonical Chat projection
  provider-adapter.ts                  # explicit media/provider capability interface
  simulator-adapter.ts                 # development/test adapter
  routes.ts                            # authenticated HTTP and media/control WS registration
  upgrade-auth.ts                      # ticket-owned WS auth and trusted principal restoration

packages/platform/src/speech/
  service.ts                           # extend capability/session policy and usage only as proven
  routes.ts                            # verified runtime credential/session operations
  adapters/                            # evaluated STT/TTS/realtime provider adapters

packages/ui/src/voice-session/
  controller.ts                        # provider-neutral client state and commands
  media.ts                             # one capture/playback owner, device lifecycle
  VoiceSessionProvider.tsx
  VoicePanel.tsx                       # literal state + supplementary activity visual
  VoiceControls.tsx
  VoicePermissionNotice.tsx
  VoiceDeviceMenu.tsx
  VoiceError.tsx
  VoiceTranscriptPreview.tsx

shell/src/
  hooks/useCanonicalVoiceSession.ts
  components/chat/                     # canonical Chat integration and entry point
  lib/voice-session-client.ts

desktop/src/renderer/src/features/chat/
  DesktopVoiceSessionControl.tsx       # shared UI composition only
desktop/src/main/media-permissions.ts  # retain trusted-renderer permission authority

tests/
  contracts/voice-session.test.ts
  gateway/voice-session/               # ticket replay/rotation, admission races, lifecycle
  gateway/chat-voice-*.test.ts         # delivery/admission/resume/memory/action prerequisites
  gateway/chat-voice-*-postgres.test.ts # owner-PG lock/crash/concurrency cases
  ui/voice-session/
  shell/voice-session/
  desktop/voice-session/
  fixtures/voice-session/              # virtual-time speech + fake harness/catalog/policy
  e2e/{shell,desktop}/voice-session*.test.ts
```

Legacy removal after parity:

```text
packages/gateway/src/vocal/{ws-handler,prompt,profile}.ts
shell/src/hooks/useVocalSession.ts
shell/src/components/{VocalPanel,AgentStatusCard}.tsx
shell/src/stores/vocal.ts               # remove or reduce to presentation-only state
```

`packages/gateway/src/server/voice-ws-routes.ts` remains for onboarding but no longer registers `/ws/vocal`.

**Structure Decision**: Keep durable behavior in existing canonical Chat and platform speech authorities. Canonical Chat must gain the minimal delivery, checkpoint, memory-policy, action-capability, and ordered-admission primitives needed by any non-text modality; the Gateway must not emulate them. Add one focused Gateway voice-session module because media/session coordination is a coherent headless responsibility. Put cross-renderer state and accessible components in `packages/ui`; shell and Electron supply transport, permissions, and local composition only.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ Web Canvas / Web Desktop / Electron Desktop                 │
│ one media owner + VoicePanel + canonical Chat presentation  │
└───────────────┬───────────────────────────────┬─────────────┘
                │ ephemeral media/control       │ durable events
                ▼                               ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│ Gateway voice session engine │   │ Canonical Chat stream    │
│ turns, epochs, playback,     │   │ messages/tools/approvals │
│ interruption, recovery      │   │ and operation results    │
└───────────────┬──────────────┘   └────────────┬─────────────┘
                │ final transcript / run events │
                └──────────────┬────────────────┘
                               ▼
                 ┌──────────────────────────────┐
                 │ Canonical Chat orchestrator  │
                 │ model, tools, approvals      │
                 └──────────────┬───────────────┘
                                │ streamed text/state
                                ▼
                 ┌──────────────────────────────┐
                 │ Speech/provider adapters     │
                 │ STT, TTS, VAD, transport     │
                 └──────────────────────────────┘
```

### Source of truth

- Canonical Chat repository: durable user/assistant messages, runs, activities, approvals, and operation outcomes.
- Canonical Chat also stores bounded, idempotent post-run speech-delivery state outside the active-run activity append path: `pending` before playback can begin, followed by acknowledged heard/interrupted boundaries or `unknown` after an unresolved crash window. Segment timestamps map to immutable text offsets. It never stores raw audio or high-frequency playback progress.
- Canonical turn admission is the single ordering authority for typed and spoken finals. It owns base-revision validation, selected agent/route, permission and interaction mode, active-run queue/steer policy, idempotency, and typed race outcomes.
- Canonical run policy carries immutable durable/session-only memory semantics through queueing, steering, adapters, tools, native checkpoints, retention, and restart.
- Gateway voice session engine: active session/transport/turn/playback coordination only; it cannot invent a second queue, approval model, or tool cancellation authority.
- Platform speech service: provider credentials, policy admission, reservations, and verified usage only.
- Client: microphone/output devices, local playback buffer, and personal presentation state only.
- Provider: disposable media/model projection; never Chat identity or durable Matrix history.

### Session startup

1. The client reads truthful voice capability for the selected Chat.
2. On explicit user action it shows the microphone rationale, requests permission, and chooses one capture owner.
3. Authenticated session creation verifies Chat write access, policy, provider health, concurrency, and budget.
4. Gateway creates a bounded session. The default Electron path uses Gateway-relayed media/control. Direct WebRTC is deferred unless a qualification spike proves narrow signaling, CSP, policy, metering, and budget enforcement.
5. Session creation issues a path/principal/session/epoch-bound one-time ticket through a dedicated upgrade-auth path; an authenticated lost response rotates the unconsumed generation rather than disclosing or reusing credentials.
6. The client connects media/control and sends its negotiated device/media capabilities; the upgrade atomically consumes the ticket, validates Origin/proxy policy, and restores the trusted principal.
7. Gateway activates the transport epoch and emits literal state; capture starts only after both sides are ready.

### Turn pipeline

1. Client or provider VAD begins a bounded turn; push-to-talk bypasses automatic endpointing.
2. Streaming recognition produces provisional revisions for the voice UI only.
3. One final transcript carries stable utterance/finality identity, base revision, selected canonical route, permissions, interaction mode, and requested queue/steer semantics into canonical admission. Duplicate, reordered, stale, and typed-race outcomes are explicit and deterministic.
4. Canonical Chat dispatches the ordinary selected Matrix agent with existing project context, tools, policy, and approvals.
5. Assistant content and activities enter the canonical event stream.
6. The session engine chunks committed stream content at safe phrase boundaries for synthesis; it never speaks hidden reasoning, approval internals, raw tool payloads, or uncommitted partial markup.
7. Audio segments are delivered with playback identities while canonical text remains visible in Chat.

### Interruption

1. Genuine barge-in or Stop speaking immediately clears/stops local playout.
2. Client acknowledges exact played-through segment/time for the active response; Gateway maps it to immutable response text and persists the idempotent post-run delivery boundary.
3. Gateway advances response cancellation state, cancels pending synthesis, and requests canonical run cancellation where policy permits.
4. Late audio/transcript from the cancelled response is rejected by response ID and transport epoch.
5. Tool cancellation is available only when the canonical harness/tool advertises targeted cancellation; generic run cancellation is never presented as exact tool cancellation. Non-cancellable/committed actions remain visible as running or outcome unknown.
6. Effective conversational context includes only content acknowledged heard before interruption. An unresolved delivery crash window projects conservatively as unknown and cannot resume a native checkpoint that contains potentially unheard text.

### Recovery

1. Transport loss moves the session to Reconnecting while canonical Chat remains usable.
2. A bounded authenticated reconnect rotates the one-time ticket and atomically advances the epoch.
3. Use a native harness/provider checkpoint only if its canonical revision, memory policy, and delivery projection all match. Existing Claude/Hermes resume routes are ineligible until they can rebuild/invalidate context that may contain an unheard suffix.
4. Otherwise invalidate native resume and rebuild the disposable provider projection from canonical summary, recent turns, pending commitments, and acknowledged delivery boundary; fail closed if a harness cannot do so.
5. Reconcile non-idempotent operations before any repeat.
6. On deadline exhaustion show Failed with Retry voice and Continue in Chat; never discard the Chat.

### Memory and privacy

- New voice-derived memories use the canonical Matrix memory proposal/review path when that path is available.
- Until canonical memory proposal is available, Aoede can rely on Chat history but must not recreate `vocal-profile.json` behavior.
- Session-only is an immutable canonical run policy, not a voice prompt hint. It suppresses durable memory writes and long-term provider state through admission, queue/steer, adapters, tools, checkpoints, retention, and restart; routes that cannot prove this are ineligible.
- Audio is processed in memory/stream and released on finalization, cancellation, disconnect, or end.
- Logging and telemetry include bounded timing, state, queue depth, network quality, usage, and correlation IDs—not raw audio/transcripts or exact sensitive action arguments.

## Provider and Transport Strategy

### Phase baseline

- Before contract freeze, focused spikes must prove: composed STT → actual canonical harness → clause TTS cadence/latency; delivery-aware Claude/Hermes reconstruction or fail-closed eligibility; argument-bound approval and action reconciliation capability; end-to-end session-only enforcement; and packaged Electron Gateway-relayed transport under current CSP.
- Deterministic speech plus a fake canonical harness/catalog/policy proves state and failure invariants without a provider or owner database.
- The hidden legacy Gemini path remains unchanged beside the new implementation until parity; it is not adapted into the new canonical engine merely for compatibility.
- The primary composed path uses streaming recognition → canonical Chat → streaming synthesis so Matrix remains the agent.

### Evaluation gate

Run the same version-pinned conformance suite against:

- OpenAI realtime/transcription/audio capabilities;
- Gemini Live and its session-resumption path;
- ElevenLabs streaming transcription and synthesis or ElevenAgents only if full canonical action conformance is possible.

Record first-audio latency, interruption behavior, transcript correction, reconnect, cancellation, verified usage, cost, privacy/data residency, browser/Electron support, and known upstream issues. Select one general-availability route plus one fallback. A provider-native speech-to-speech route cannot ship merely because it sounds better; it must preserve canonical action and history invariants.

The action capability matrix is explicit per harness/tool: exact normalized-argument digest approval, idempotency/reconciliation, and targeted cancellation are independent capabilities. Hermes full-access/yolo and any route without digest-bound approval are fail-closed for consequential voice actions rather than wrapped in voice-owned enforcement.

## UI and Interaction Design

### Composition

- The active Chat remains visible and owns the transcript, tools, approvals, and results.
- Voice opens a compact overlay/panel attached to Chat without shifting layout.
- Literal state sits next to a restrained activity visual. The existing Matrix waveform is reused for input; an ElevenLabs-inspired orb is optional and lazy-loaded only if it adds value without a heavy default dependency.
- Mute/Hold, Stop speaking, push-to-talk, and End remain persistent when applicable.
- Device and voice settings use progressive disclosure; permission or connection recovery is inline and actionable.
- Closing the panel while capture continues leaves a persistent, unmistakable microphone control; the default close behavior pauses or ends unless the user explicitly chose background voice.

### Accessibility

- Status changes use a throttled polite live region; failures and microphone revocation use assertive announcements only when immediate action is required.
- Every icon control has a state-specific accessible name and visible focus.
- Focus enters the panel on open and returns to the trigger on close; Escape and trigger toggle follow the UX guide.
- Transcript sender and provisional/final state are conveyed semantically, not by alignment/color alone.
- Reduced motion replaces waveform/orb motion with static level/state treatment.
- Controls retain touch-safe targets, zoom/large-text behavior, and high-contrast legibility.

### Surface matrix

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | Shared VoicePanel attached to canonical Chat | Full initial capability | Full | Component + Playwright | Required first |
| Web Desktop | Same shared panel in Desktop Chat | Equivalent | Full | Component + Playwright | Required |
| Electron Desktop | Same shared semantics with native permission/device adapter | Equivalent plus packaged media checks | Full | Renderer + Electron E2E | Required |
| Web Mobile | Hidden or explicitly unsupported in initial release unless existing responsive Chat can meet full contract | No partial launch | Safe unsupported state | Routing/capability | Rationale/evidence |
| Native Mobile | Deferred renderer on shared contract | No advertised nonfunctional control | Safe unsupported state | Contract/capability | Follow-up |

## Security, Limits, and Operations

- Follow [contracts/voice-session-api.md](contracts/voice-session-api.md) for auth and strict schema boundaries.
- Session tickets are random, single-use, short-lived, digest-stored, and bound to principal, Chat, session, path, generation, and epoch. Upgrade auth atomically consumes them, validates trusted Origin/proxy policy, and restores the server-authenticated principal; it is not a broad exception in global auth middleware.
- Concurrent reconnect and create/retry after a lost session-creation response rotate credentials atomically; an old or consumed generation cannot attach.
- No client chooses provider URLs, tools, system prompts, owner IDs, runtime IDs, budgets, or model policy.
- Provider requests, credential minting, and shutdown all have explicit timeouts and typed safe errors.
- Registries, queues, event histories, reconnect attempts, transcript buffers, synthesis segments, and timers are capped and cleaned on eviction/end.
- Admission and ticket consumption are atomic; network/provider calls stay outside database locks.
- A cleanup/drain operation cannot make a terminal session admissible again.
- Telemetry includes session/turn/run correlation, connection/first-audio/end-of-turn latency, interruption latency, queue depth, reconnect path, tool/approval outcomes, usage, and WebRTC/WebSocket health.

## Delivery Stack

The Aoede rewrite exceeds one reviewable PR. Use a Graphite stack after Graphite is installed/authenticated. The current branch is based on open local-development PR [#2040](https://github.com/HamedMP/matrix-os/pull/2040); track that parent and do not flatten or publish a competing base.

### Layer 1 — Qualification spikes, contracts, and simulator foundations

**Suggested title**: `spike(voice): qualify canonical realtime architecture`

- Run and record the five pre-contract qualification spikes: composed latency/cadence, Claude/Hermes heard-history reconstruction, action safety capability, session-only enforcement, and packaged Electron relayed transport.
- Define strict session/capability/frame schemas only after the evidence resolves open contracts.
- Add virtual clock, speech/media simulator, fake canonical harness/catalog/policy/admission/delivery repository, scenario corpus, and golden journal assertions.
- Add a database-free `dev:voice:fixture` with seeded canonical Chat presentation and representative degraded states.
- Cover early interruption, stale epochs, transcript corrections, backpressure, reconnect, approval, cancellation, quota, and cleanup.
- No production provider, legacy behavior change, or broad auth bypass.

**Checkpoint**: qualification evidence passes or narrows initial capability; the fixture runs without VM/provider/database; contracts freeze only now.

### Layer 2 — Canonical delivery, resume, and memory foundations

**Suggested title**: `feat(chat): add delivery-aware voice context policy`

- Add the idempotent post-run delivery repository with `pending`, acknowledged heard/interrupted, and `unknown` crash states plus immutable segment/time-to-text mapping.
- Add native-checkpoint eligibility and projection/rebuild hooks; Claude/Hermes fail closed until interrupted/restarted spoken and typed continuation excludes unheard text.
- Carry immutable durable/session-only memory policy through canonical admission, queue/steer, adapters, tools, checkpointing, retention, and restart.
- Use PGlite for ordinary repository tests and disposable PostgreSQL for concurrency, crash-window, lock, and restart behavior.

**Checkpoint**: canonical text Chat remains unchanged by default; every eligible harness reconstructs safe context, and session-only writes nothing durable beyond allowed Chat/audit records.

### Layer 3 — Canonical action safety and ordered admission

**Suggested title**: `feat(chat): qualify voice actions and ordered turn admission`

- Add the per-harness/tool capability matrix for normalized-argument approval digest, reconciliation/idempotency, and targeted cancellation.
- Extend canonical approvals where required; do not implement voice-owned enforcement. Consequential action routes that cannot satisfy the matrix are unavailable to voice.
- Add one canonical typed/voice admission contract with base revision, route selection, permission/interaction mode, stable finality identity, and queue/steer semantics.
- Test duplicate and reordered STT finals, simultaneous typed input, active-run policy, approval drift, Hermes ineligibility, disconnect-after-commit, and unknown outcomes.

**Checkpoint**: no duplicate turn/side effect and no action executes against drifted arguments; unsupported harness/tool combinations fail closed with truthful capability.

### Layer 4 — Gateway session engine and ticket-owned transport auth

**Suggested title**: `feat(voice): connect realtime sessions to canonical chat`

- Implement capped registry, lifecycle engine, segment ledger, context projector, canonical bridge, routes, shutdown, and simulator adapter.
- Add dedicated one-time-ticket WebSocket upgrade auth with principal restoration, atomic consumption, trusted Origin/proxy policy, generation rotation, concurrent reconnect semantics, and a credential-less status response when idempotent create finds an already-consumed session.
- Admit voice finals only through canonical ordered admission; consume canonical assistant/activity events for synthesis; invoke only canonical action/approval paths.
- Add simulator/PGlite integration plus disposable-PostgreSQL ticket and crash/concurrency tests.

**Checkpoint**: Gateway simulator proves one durable Chat, safe interrupted context, accurate actions, reconnect, lost-response rotation, and zero duplicate side effects.

### Layer 5 — Shared Web voice experience

**Suggested title**: `feat(voice): add accessible Matrix voice mode`

- Build the shared controller/media owner and accessible VoicePanel primitives.
- Integrate Web Canvas and Web Desktop canonical Chat.
- Implement permission rationale, device selection, hands-free/push-to-talk, literal states, transcript preview, controls, recovery, reduced motion, and enforced session-only mode.
- Adapt only selected ElevenLabs MIT patterns; preserve license attribution for copied source.
- Run React Doctor, production shell build, component tests, Playwright, and inspected screenshots.

**Checkpoint**: approved UX scenarios pass in Web Canvas first and Web Desktop second with no layout shift, hidden microphone, or voice-only representation of canonical activity.

### Layer 6 — Electron and provider conformance

**Suggested title**: `feat(voice): qualify desktop media and realtime providers`

- Integrate Electron Desktop through shared UI, trusted media permission boundary, and Gateway-relayed transport under the packaged CSP.
- Keep direct provider WebRTC deferred unless a separate narrow signaling/control/metering/CSP qualification passes.
- Extend Platform Speech only for exact credential, policy, usage, STT, and TTS operations selected by spikes.
- Add version-pinned candidate adapters that pass the canonical contract; evaluate Gemini without inheriting legacy second-agent behavior.
- Run real-provider conformance and publish the evidence-backed GA/fallback decision.
- Validate packaged microphone/output devices, suspend/resume, network changes, interruption, and cleanup.

**Checkpoint**: one GA route and fallback meet thresholds; Electron parity, CSP, provider, cost, and privacy evidence are complete.

### Layer 7 — Migration, legacy removal, and release

**Suggested title**: `refactor(voice): retire legacy Aoede runtime`

- Resolve every legacy capability parity item.
- Stop registering `/ws/vocal`; remove its Gateway handler/prompt and shell mirrored protocol.
- Retire guessed `AgentStatusCard` progress and use canonical operation state.
- Define explicit inspect/export/delete or discard handling for existing `vocal-profile.json`; do not silently ingest it.
- Remove hidden/dead Aoede launch paths and expose the canonical voice entry under rollout policy.
- Run migration regression, full required checks, real-provider smoke, all visual/accessibility evidence, and `dev:full --reuse-bundle` production parity.
- Create the separate `FinnaAI/matrix-os-site` documentation PR covering permissions, controls, privacy, limits, recovery, supported surfaces, and troubleshooting.

**Checkpoint**: no old voice authority remains, no unresolved parity item exists, current-head Greptile is 5/5 for every layer, CI passes, and merge/deployment awaits explicit user approval.

## Test and Evidence Strategy

### Tests designed to catch plausible wrong implementations

- **Stale connection mutation**: epoch A disconnects, epoch B reconnects, then A sends late transcript/audio; only B may advance state.
- **Duplicate/reordered admission**: finals are duplicated and arrive out of order around a typed turn; canonical Chat applies the declared base-revision/queue/steer policy and creates no duplicate run.
- **Unheard-history bug**: interrupt halfway through asymmetric response text, restart, then continue once by speech and once by typing; both contexts exclude the unheard suffix, including Claude/Hermes native-resume paths.
- **Playback crash windows**: crash before pending delivery, after pending but before acknowledgement, and after acknowledgement; recovery yields the specified absent/unknown/heard projection without guessing.
- **Zero-frame interruption**: interrupt before first audio; no invalid zero-length truncation and next turn still works.
- **Action replay**: disconnect after side effect commits but before acknowledgement; recovery reconciles or marks unknown and never repeats.
- **Approval drift and eligibility**: approved arguments differ by one normalized field at execution, and Hermes/full-access lacks exact approval; execution is rejected or capability is unavailable.
- **Session-only escape**: memory-capable tools and native checkpoints run before and after restart; no durable memory/provider state is retained.
- **Ticket replay/rotation**: creation response is lost while reconnects race; only the latest authenticated generation attaches and consumed/old tickets fail.
- **False completion**: unrelated app appears while build runs; voice still reports canonical running state.
- **Backpressure**: synthesis/provider stalls while capture continues; queues stay bounded and session pauses/fails explicitly.
- **Cleanup race**: End, socket close, provider failure, and timeout arrive together; cleanup runs once and releases all resources.
- **Chat focus drift**: user selects Chat B while voice is bound to Chat A; transcript remains in A and UI discloses ownership.
- **Electron transport policy**: packaged app connects through the allowed Gateway relay under current CSP; no unapproved provider origin or broad CSP expansion is needed.
- **Permission/device loss**: removal during capture stops tracks and offers selection without invisible recording.
- **Reduced motion/accessibility**: state remains fully understandable with animation disabled and screen-reader-only navigation.

### Verification order per layer

1. Write and run a focused failing test.
2. Implement the smallest behavior and rerun focused tests.
3. Run affected package typecheck and pattern scan.
4. For UI, run React Doctor and render/inspect required states.
5. Run integration/conformance checks appropriate to the layer.
6. After the final edit, run repository-required checks for the actual changed scope.
7. Push only with authorization, request Greptile review for the current head, and do not merge before 5/5 and explicit approval.

## Rollout and Compatibility

- Keep the legacy Aoede entry hidden while simulator and canonical paths are built.
- Gate the new entry on truthful capability and rollout policy, not presence of a key.
- Run internal opt-in with deterministic telemetry and no raw content logging.
- Preserve text Chat as the immediate fallback for every failure.
- Roll back by disabling new session admission; canonical Chat content remains valid and legacy removal does not occur until the new path passes release gates.
- Onboarding remains on its existing Gemini path during this feature; any later engine convergence is separately reviewed.

## Deferred Scope

- Native Mobile visual/media implementation.
- Onboarding migration.
- Telephony and messaging voice notes.
- Whole-screen understanding or autonomous desktop input.
- Recording history, voice cloning, emotion analysis, and raw-audio retention.
- Multiple simultaneous active voice sessions for one user.

## Phase Outputs and Readiness

- Phase 0 complete: [research.md](research.md) resolves product, architecture, provider, UI, and testing decisions.
- Phase 1 design complete but contract freeze intentionally pending: [data-model.md](data-model.md), [contracts/voice-session-api.md](contracts/voice-session-api.md), and [quickstart.md](quickstart.md) define the hypotheses, security boundaries, integration, and validation modes that Layer 1 must prove.
- Phase 2 follows after final user acceptance: Layer 1 qualification/simulator tasks may begin, but Layers 2–7 contracts remain revisable until the qualification evidence is recorded and reviewed.
- Run `speckit-tasks` twice if needed: first for qualification work, then refresh dependency-ordered implementation tasks after contract freeze. Do not encode unresolved spike outcomes as implementation fact.

## Complexity Tracking

No constitutional violation is required. The new Gateway module is justified by a coherent responsibility—ephemeral media/session coordination—that neither canonical Chat nor batch transcription currently owns. The required canonical Chat changes are modality-neutral primitives at the existing authorities, not a voice-owned conversation, memory, action, approval, or provider authority.

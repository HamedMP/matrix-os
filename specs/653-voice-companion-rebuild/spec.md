# 653: Voice companion rebuild on main

- Ticket: [ENG-476](https://linear.app/matrix-os/issue/ENG-476/featvoice-run-the-gemini-live-companion-on-matrix-pi-with-full-matrix) (child of ENG-125)
- Supersedes for landing purposes: the Aoede stack #2274 -> #2175 -> #2181 -> #2260 -> #2261 -> #2262 -> #2172 (+#2176, #2204). Design history stays in `specs/535-aoede-rewrite` and `specs/547-aoede-live-companion` on those branches.
- Answers ENG-274 (how the trial becomes a product): keep / rework / drop below.

## Goal

The owner can talk to Matrix by voice at any time, from any OS view, using Gemini Live. Voice is one more entry point to the same Matrix Pi Chat that typed chat and WhatsApp use, with the same Matrix tools. The voice provider is swappable (GPT Realtime next).

## Why rebuild instead of rebasing

The stack is 502 files, +61.8k/-5.1k against a merge-base 563 commits behind `main` (2026-11-14), with conflicts in chat core. A trial port on `main` (stash on `feat/eng-476-voice-companion-rebuild`) showed:

- The native Live core (`live-companion/*`, `voice-session/{adapter,ports,session-runtime,session-pipeline,simulator-*}`, `platform/native-live/*`, `contracts/voice-session.ts`, about 4.8k lines) compiles on `main` with 10 gateway errors and one missing platform table type. All have known fixes (below).
- The stack's server wiring (`server/canonical-voice.ts` -> `voice-session/routes` -> `engine` -> `canonical-ports` -> `chat/voice-delivery-repository`) is what pulls in the speech-to-text/text-to-speech cascade, the action-authority layer (`chat/action-*`, `argument-digest`) and changes to about 20 chat-core files. That part is rewritten thin, not ported.

## Keep / rework / drop

| Piece | Decision | Notes |
|---|---|---|
| `contracts/voice-session.ts` | Keep | Frame schemas, audio formats. |
| `voice-session/adapter.ts`, `ports.ts` | Keep | `VoiceMediaAdapter` is the provider swap point. Replace the `CanonicalChatRunPolicy` type import with a local `VoiceExecutionPolicy` union. |
| `voice-session/session-runtime.ts`, `session-pipeline.ts` | Keep | Both near 1k LOC: split by responsibility while porting (large-file rule). |
| `voice-session/ticket-auth.ts` | Keep | Standalone HMAC ticket for the browser WebSocket upgrade. |
| `live-companion/gemini-adapter.ts`, `coordinator.ts`, `funded-readiness.ts`, `registration.ts`, `session-port.ts`, `canonical-decision.ts` | Keep | `gemini-3.8-live`, NON_BLOCKING tools, WHEN_IDLE responses. |
| `onboarding/gemini-live.ts` | Rework | Port the stack's client upgrade (`restoreContext`, `sendAudioStreamEnd`, finished transcripts, proxy `endpoint`, extra options argument) while keeping legacy `/ws/onboarding` behavior. |
| `live-companion/history.ts`, `task-broker.ts` | Rework | Become the Matrix Pi `LiveCompanionPort` (see Journey). |
| `live-companion/voice-title.ts`, `chats.conversation_kind`, `chat/voice-history-schema.ts`, #2260 | Drop | Voice is not a separate kind of Chat. |
| `platform/native-live/*` + `gemini-live-proxy.ts` | Keep | Platform-held key, funded sessions. Add `native_live_sessions` to `PlatformDatabase`. |
| Cascade engine: `engine.ts`, `routes.ts`, `canonical-ports.ts`, `openai-adapter.ts`, `direct-openai-ports.ts`, `speech-ports.ts`, `adapter-registration.ts`, `speech/managed-readiness.ts`, `speech/voice-session-ports.ts`, `chat/voice-delivery-repository.ts` | Drop | Native Live replaces it. GPT Realtime will be a second native adapter. |
| `chat/action-*`, `argument-digest`, run-policy columns, provider-adapter `qualifyPolicy`/`cancelTool` | Drop for now | Voice delegates to Matrix Pi, whose owner tools already carry their own authority. Revisit only if a voice-specific grant is needed. |
| `aoede/*` bootstrap/binding | Drop | Replaced by "voice joins a Chat id". |
| UI: `packages/ui/voice-session/*`, `ui/aoede/*` | Rework | Keep capture/playback/transport and the panel; drop cascade states. Trim to native frames only. |
| Production-parity scripts and other non-voice files in #2274 | Drop | Already on `main` or unrelated. |

## Journey

1. The owner presses the voice button (mini chat, Chat app, or dock) or an app calls the voice API. The client asks the gateway for a voice ticket for a Chat id. With no Chat id, the gateway uses the owner's most recent generic Chat: not in any project (`project_id IS NULL`), not shared (`collaboration IS NULL`), on the Matrix Pi route. If none exists it creates one on the `matrix_pi_default` route.
2. The client opens `/ws/voice/live?ticket=...`. The gateway opens Gemini Live through the platform relay, restores the last turns of that Chat as context, and streams audio both ways (16 kHz in, 24 kHz out).
3. Each finished user utterance and each spoken reply is journaled as an ordinary message in that Chat, so typed chat, WhatsApp and the Chat list all see the same history.
4. When the owner asks for work ("build an app", "open a terminal", "send Ali a message"), Gemini calls `delegate_task`. The Matrix Pi port submits a normal turn to the same Chat (or a linked child Chat for long tasks) through the canonical orchestrator. Matrix Pi runs it with its full owner tool set. Gemini keeps talking while it runs and reports completion from `check_task` / task events.
5. Ending the call closes Gemini, finishes the journal, and leaves the Chat usable by text.

## Matrix Pi tools (shared by typed chat, WhatsApp, voice)

Present today in `chat/managed-pi-owner-tools.ts`: `integration.*`, `browser.action`, `mcp.*`, `github.developer`, `agent.task`, `agent.activity`.

To add (one layer, all entry points benefit):

- `terminal.*`: create a tab in a project workspace (`/api/terminal/workspaces`), send input, read recent output. Uses canonical `TerminalRef { workspaceId, tabId }`.
- `message.send`: send through an owner's connected channel (Matrix, WhatsApp, Telegram) with explicit recipient confirmation.
- `app.open` / `app.close`: open an app path in the owner's active OS view through the existing shell event channel.

## Provider swap

`VoiceMediaAdapter` stays the only provider seam. `registration.ts` picks an adapter by id (`gemini_live` now, `openai_realtime` later) from a gateway setting. The companion tools, the journal, and the Matrix Pi port do not depend on the provider.

## Layers (one native GitHub stack, ENG-476)

First stack: a demoable call on Web Desktop and Web Canvas.

| Layer | Content | Size |
|---|---|---|
| L1 | Spec (this file) | docs |
| L2 | Native core: contracts, lean `VoiceMediaAdapter` seam, Gemini Live client upgrade, companion coordinator, Chat journal and task broker (ported with their stack tests) | ~2.4k |
| L3 | Live route: generic Chat resolver, session host (limits, frame validation), owner-scoped call registry, `/ws/voice/live` + `/api/voice/live/status`, server wiring | ~0.6k |
| L4 | Shell: `useVoiceLive`, `VoiceLivePanel` overlay, dock button unhidden, Talk button in the Chat composer | ~0.45k |

The thin session host in L3 replaces the stack's `engine`, `session-runtime` and `session-pipeline`; native Live needs no engine-side admission, delivery ledger or synthesis.

Follow-on stack: platform-funded native Live sessions (`platform/native-live`, per-session budget reservation), task event watching, Electron Desktop and mobile surfaces, Matrix Pi `terminal.*` / `message.send` / `app.open` tools, GPT Realtime adapter, and removal of legacy `/ws/vocal` + `VocalPanel`.

## Security

- Auth matrix: the WebSocket upgrade uses gateway auth (session/JWT, or the query token for browsers, via the query-token allowlist); the principal is read server-side. The client never names an owner or a capture turn; a requested Chat id is validated and must be owned and unshared.
- No user Gemini key. On a VPS the gateway reaches Gemini only through the existing platform relay; locally it uses the operator `GEMINI_API_KEY`. Per-session funding and budget reservation land in the follow-on stack.
- All client frames are Zod-validated after JSON parse; audio frames are size-capped.
- Delegated work runs as ordinary Matrix Pi turns, so existing owner-tool authority and approvals apply unchanged. `message.send` and other outward actions require confirmation.
- Client errors are generic codes (`session_limit_reached`, `provider_unavailable`); provider names and raw errors are logged server-side only.

## Failure modes

- Gemini drop or relay timeout: session emits a recoverable error; the Chat keeps every journaled turn; a new call restores context from the Chat.
- Gateway restart mid-call: the call ends; in-flight delegated turns are durable Chat turns and continue.
- Concurrent voice + typed input on one Chat: both go through canonical turn admission; ordering is the Chat's sequence.
- Funding exhausted: relay refuses before audio starts; the client falls back to text.

## Resource limits

- One live call per owner (a new call replaces the old one), at most 8 owners per gateway, 90 s idle timeout, 30 min maximum call length, 256 KB client frame cap.
- Bounded in-memory maps in the coordinator (at most 3 in-flight delegations) and session registry with TTL sweep and shutdown drain.
- No raw audio is persisted.

## Acceptance

- From Web Desktop, Web Canvas and Electron Desktop the owner talks to Matrix and hears replies; transcripts appear in the same Chat that the Chat list and WhatsApp show.
- "Open a terminal in project main" by voice creates a terminal tab; "build me a habit tracker" starts a Matrix Pi turn and the companion reports when done.
- Switching the adapter id to a stub second provider needs no change outside the adapter.
- Live evidence per surface on a preview VPS, per the repo evidence gate.

## Later (not in this stack)

Voice onboarding (opt-in), an interview API any app can start, company employee interviews with group analysis (spec 120 US-11), Native Mobile and Web Mobile voice.

## Decisions

- 2026-11-14 (requester): with no Chat id, voice joins the most recent generic Chat (not in any project), as specified in Journey step 1.
- 2026-11-14 (requester): no voice-specific grant. Voice uses Matrix Pi authority as is; outward actions require the owner's confirmation.

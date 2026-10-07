# Implementation Plan: Aoede Live Voice Assistant

**Branch**: `548-aoede-live`, created from `fix/production-parity-local-dev` (PR #2040) | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)
**Input**: [spec.md](./spec.md), [research.md](./research.md)

## Summary

Siri-style full-screen voice assistant. **GPT-Live-1 in client-delegation mode** owns speech, VAD, interruption and browser WebRTC transport. Matrix retains owner authorization, profile facts, app data and canonical durable Chat execution. The platform funds and mints sessions and proxies the trusted sideband; the gateway handles transcripts and delegation. The shell reuses its overlay host, dock, palette and existing authenticated `/ws` connection for cards and UI actions.

Only orb CSS is ported from `feat/aoede-product-rebuild`. Preserve `vocal/profile.ts` and `shell/src/stores/vocal.ts`; replace the legacy Vocal transport and panel only after all consumers use the replacement. This revision incorporates the [Ultra review](https://ampcode.com/threads/T-01a11468-15bb-70dc-af67-055ed1d70799); provider qualification remains incomplete.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node 24, ES modules
**Primary Dependencies**: Native `fetch` for OpenAI REST and existing `ws`, Hono, React 19 and Next 16. No new package. `openai` is only a transitive dependency today; do not import it without declaring it in the owning package and obtaining approval for that alternative.
**Storage**: Owner Postgres/Kysely for the Aoede Chat, session binding, bounded text recovery checkpoint and delegation-to-run mapping. Platform speech operation/reservation records remain the monetary source of truth. Profile facts stay in `~/system/vocal-profile.json`. No stored provider audio (`store: false`).
**Testing**: TDD for concrete authorization, delivery, persistence, cancellation, recovery and billing outcomes. Real disposable SQL/filesystem and production Chat decisions; fake only external provider I/O. Browser checks for interaction and visuals. Paid provider qualification is a separate, explicitly invoked gate, not a silently skipped passing test.
**Target Platform**: Web Desktop and Web Canvas shells; gateway on the per-user VPS; platform mints sessions.
**Project Type**: Web (gateway + platform + shell packages).
**Performance Goals**: SC-001..008 are qualification targets, not established results. The spike measured 0.4–0.8s response latency over two short fake-backend sessions, not production reliability.
**Constraints**: Roughly 2K lines of product code and 1.5K lines of tests, including new contracts, migrations and styling in the appropriate count. No custom audio/VAD engine or automatic reconnect protocol; every external call is bounded. If correct integration exceeds the budget, report it before expanding scope or removing meaningful verification.
**Scale/Scope**: One active session per owner, bound to its runtime and invoking shell. Proposed application duration cap: ten minutes, or earlier provider expiry. Reserve the cap plus bounded startup/finalization headroom before minting; qualify termination and the reservation envelope before rollout. A local close timer is not a guaranteed provider dollar cap during a network outage.

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Data belongs to owner | Designed | Recovery text stays in owner Postgres, bounded and deletable; platform receives content-free billing records. Existing facts are preserved. |
| II/III. Kernel and headless core | Designed | Reuse canonical Chat; browser renders authorized UI effects, not a second execution engine. |
| VIII. Defense in depth | Designed | Auth matrix below, runtime-bound speech identity, funded dispatch, restricted data channel, session/owner checks, limits and generic errors. |
| IX. TDD | Required | Red → green for business outcomes; test counts and coverage do not establish product correctness. |
| X. Branch/review workflow | Owner override | User explicitly requested an ordinary branch and no new worktree. #2040 must land before the upstream Aoede PR is based on main; review and CI gates still apply. |
| Public docs | Required | Separate documentation PR in `FinnaAI/matrix-os-site/content/docs/`. |
| Kysely and size limits | Designed | Reuse existing repositories; narrow session metadata migration, no new wallet table or ORM. Keep PR below 3K additions/50 files or revise delivery scope. |

Design checks are not executed proof. Do not begin delegation until lifecycle/funding tests pass; do not claim release readiness before provider and browser qualification.

## Project Structure

### Documentation (this feature)

```text
specs/548-aoede-live/
├── spec.md
├── plan.md              # this file
├── research.md          # spike results (done)
├── contracts/
│   └── aoede-api.md     # /api/aoede/* + shell event frames (Phase 1)
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code

```text
packages/platform/src/speech/
└── live-session-mint.ts          # funded REST mint, runtime/session binding and finalization
packages/platform/src/           # wire sideband proxy into existing HTTP upgrade dispatcher
packages/platform/src/speech/    # extend existing config, operation policy and funding lifecycle for Live

packages/gateway/src/aoede/
├── prompt.ts                     # Aoede persona + when-to-delegate; profile facts injected                      (~80)
├── transcript.ts                 # bounded fragments, timestamp-aware context and recovery checkpoint
├── actions.ts                    # Zod discriminated union: open_app, close_app, list_apps, note.*, fact.*         (~150)
├── delegate.ts                   # delegation → grace → classify → direct action | admitTurn(); run events →
│                                 #   thinking/commentary, existing HTTP approvals and cancellation
├── session.ts                    # funded mint, sideband lifecycle, explicit fresh-session recovery
└── routes.ts                     # POST/DELETE /api/aoede/session; no additional browser WebSocket

packages/gateway/src/vocal/profile.ts        # keep; add listFacts/forgetFact                                       (+30)
packages/gateway/src/db/migrations/          # next version: owner session/checkpoint/delegation bindings
packages/gateway/src/server/types.ts         # aoede:* frames on existing owner /ws broadcast

shell/src/aoede/
├── useAoedeSession.ts            # WebRTC/captions; existing useSocket and canonical-chat-client
├── AoedeOverlay.tsx              # full-screen halo (from VocalPanel) + orb (CSS from rebuild branch) + captions
│                                 #   + build/approval cards + settings; Esc/focus restore; reduced motion          (~300)
├── aoede.css                     # ported orb/halo styles, counted as product code
└── index.ts
shell/src/stores/vocal.ts         # retain visibility store; wire Desktop/AoedeDockButton/palette to new overlay
shell/src/lib/feature-flags.ts    # handle VOICE_HIDDEN deliberately after replacement wiring

tests/gateway/aoede/              # focused business-flow regressions, not one suite per helper
tests/platform/                  # funded mint/failure/finalization/credential isolation
tests/integration/               # explicit paid Live qualification; missing required setup fails visibly
Browser                          # Desktop/Canvas, active/denied/recovery/approval/reduced-motion states

Deleted: packages/gateway/src/vocal/{ws-handler,prompt}.ts, packages/gateway/src/server/voice-ws-routes.ts (vocal part),
         shell/src/hooks/useVocalSession.ts, shell/src/components/VocalPanel.tsx after replacement qualification.
         Remove /ws/vocal from auth allowlist and route inventory; preserve shared onboarding/other voice routes.
```

**Structure Decision**: Extend the existing gateway, platform and shell. No new package, event socket, subscriber registry or wallet. Keep data-model and boundary decisions below in this plan; expand contracts during the first slice, not a second framework.

## Design

### Auth matrix and boundary contracts

No route below is public. Names for new internal endpoints are planned, not existing APIs; register them in the platform dispatcher and gateway route inventory.

| Route/transport | Authentication and authority | Limits and result |
|---|---|---|
| `POST /api/aoede/session` | Existing owner `RequestPrincipal`; owner/runtime inferred server-side | `bodyLimit` 64 KiB; `{ clientRequestId, sdp }`; returns only application session ID, provider ID and answer SDP. No client-supplied owner, prompt, backend selection or funding claim. |
| `DELETE /api/aoede/session` | Owner plus current server-side session binding | `bodyLimit` 1 KiB; targeted session ID so a stale tab cannot close its replacement; repeat close is idempotent. |
| Existing `/ws` | Existing owner socket auth | Extend bounded `aoede:*` schemas for cards, session readiness and correlated UI acknowledgements. These never authorize data writes or mint approval proof. |
| Existing approval POST `/api/chats/:chatId/runs/:runId/approvals/:approvalId` | Authenticated shell request through platform, owner/run checks and platform approval proof | Reuse strict `{ clientRequestId, decision }` contract and existing limits. No direct in-process voice submit. |
| Internal `POST /internal/containers/:handle/aoede/session?runtimeSlot=…` | Speech runtime token verified against current machine/epoch, owner derived from platform DB | 64 KiB body; funded operation before REST dispatch; minimal answer, `Cache-Control: no-store`. |
| Internal WS `/internal/containers/:handle/aoede/sessions/:id/attach?runtimeSlot=…` | Same runtime identity AND platform-owned session/reservation binding | Fixed OpenAI host, validated opaque ID, 512 KiB frames, bounded upgrade/queue, one active control connection. Reject another owner's session ID even with a valid runtime token. |

Provider configuration is constructed server-side: `{ session: { model: "gpt-live-1", instructions, input, store: false, audio: { output: { voice } }, delegation: { type: "client" }, client: { data_channel: … } }, transport: { type: "webrtc", sdp } }`. Native fetch sends this to `POST https://api.openai.com/v1/live/sessions` with a 15s timeout and no redirects or automatic retries. Creation returns `session.id` and `transport.sdp`, not a guaranteed `expires_at`; record expiry from subsequent provider session snapshots when available and always enforce the application cap.

Set `allowed_client_events: ["session.close"]`. Allow browser server events only for `session.started`, input/output transcript deltas, `session.closed`, `error` and `info`, using `{ type }` selectors. All delegation handling and context appends stay on the trusted sideband. Do not omit permissions: omission allows all events. Browser transcript/status reports are not authoritative for execution or billing. Decode only consumed bounded provider events; discard reflected raw audio rather than retaining it.

### Session lifecycle

1. Request microphone permission before a billable mint. Prepare WebRTC and its data channel, then POST with a stable invocation ID. Stop local tracks on every startup failure.
2. Reserve a `connecting` owner session atomically, serialize competing invocations and create the platform funded operation. Provider I/O is outside DB transactions. A repeated invocation cannot create another billable session; changed payload under the same request ID is rejected.
3. Platform reserves the maximum bounded-session cost via `SpeechFundingPort`, marks dispatch started and mints through REST. It persists the provider/session/reservation binding before returning. Gateway persists its binding and attaches through the platform before returning answer SDP. If mint succeeds but a later step fails, close the provider session and finalize its charge; do not pretend it never existed.
4. Shell applies answer. On `session.started`, notify the gateway via existing `/ws`; gateway sends the greeting once for the matching active session and checks the append acknowledgement/error. This readiness signal grants no action authority. Qualify event ordering because sideband attachment does not replay earlier startup events.
5. A newer invocation supersedes and closes the old provider session, settles its usage independently and notifies its shell. Old-session callbacks cannot mutate the new session or its cards. Enforce the application duration cap and surface earlier provider expiry.
6. Dismissal stops local capture/playback immediately, sends close and restores focus; leave the sideband receiving until `session.closed` or a bounded finalization deadline (initially 15s). Persist final usage once, then drain sockets/timers. Builds continue independently in Chat.
7. On gateway restart, mark old active voice sessions interrupted. Reattach only to attempt closure/finalization, never to assume missed events will replay. Offer an explicit fresh session seeded with saved text and current Chat outcomes. Do not automatically mint while the user is absent or replay unfinished mutations whose outcome is unknown.

### Data ownership and recovery

Owner session records contain owner/runtime, invocation/application/provider IDs, chat ID, start/end/nullable provider expiry, state and a bounded recovery checkpoint. Use at most 24 recent text messages and 16K characters; trim startup history further to fit the provider's 128-message/8,192-token limit. Preserve role/text/timing; never persist raw audio or put conversation text into platform funding records. Delete expired recovery checkpoints after 24 hours and support owner deletion/export. Facts and durable Chat history are separate and retained under their existing policy.

Persist delegation bindings under a unique `(sessionId, providerDelegationId)` before dispatch, with a stable Chat request ID and run/queued-turn ID when admitted. Checkpoint conversation text before admitting work. Replay deduplicates through this binding and canonical admission; a pending direct mutation with an uncertain outcome is reported as uncertain, not retried automatically. Keep only the latest owner recovery text checkpoint, but retain unresolved delegation bindings until their outcome is reconciled. Cap live buffers/queues and clean up on close, supersession and shutdown. A crash can lose uncheckpointed speech; tell the user rather than claiming lossless recovery.

### Delegation handling (`delegate.ts`)

```
session.delegation.created
  → correlate transcript timing with delegation offset; bounded grace (300ms starting hypothesis)
  → snapshot recent context; persist/deduplicate delegation binding
  → classify(context.lastUser):
      direct action regex/schema match (open/close/list app, note add/edit, remember/forget/list facts)
        → authorized action → verified persistence or correlated shell acknowledgement → commentary
      otherwise
        → admitTurn(principal, owner, chatId, canonicalRequest); queue if busy, retry revision conflict once
        → thinking.append(verified admission status, ≤500 tokens)
        → subscribe canonical Chat events with cursor replay and periodic touch():
             tool activity   → owner /ws card update (no fabricated stage)
             approval needed → approval card + spoken question; decision uses existing HTTP route
             terminal ok     → commentary.append(result summary, ≤500 tokens); card → done
             terminal fail   → commentary.append(plain failure); card → failed
  → stale delegation ID → retry with null only for the correlated rejection, not arbitrary send failure
```

Create or retrieve the owner's Chat titled "Aoede" with an idempotent server-derived create request, following `bots/instantiation.ts`. Admission follows `bots/continuations.ts`: read the current Chat revision; construct `{ clientRequestId, baseRevision, parts: [{ type: "text", text: voiceContext }], selection, interactionMode, permissionMode }`; call `admitTurn(principal, { type: "personal", ownerId: principal.userId }, chatId, input)`. Reuse Chat's current allowed selection/modes, not invented `runPolicy` or bot defaults. The voice preamble is explicit input text; actor remains the real user. Queue on `chat_busy`, retry one revision conflict, and persist admission IDs before announcing start.

Spoken decisions require exactly one current approval, a question actually presented in this session, and an unambiguous complete affirmative/negative utterance. A confirmed decision emits a session-bound `aoede:approval_decide` frame to the invoking shell; `canonical-chat-client.submitApproval()` performs the authenticated HTTP POST with a stable request ID. The platform mints proof and Chat revalidates owner/run/allowed decisions. Wait for accepted submission/current run state before confirming. Never call `orchestrator.submitApproval()` directly from voice or mint weaker internal proof. Restrict voice approval to explicitly low-risk canonical approvals; medium/high/unknown risk and destructive operations require a click. Do not infer safety from spoken wording, grant session-wide permission, or resolve an ambiguous/stale approval.

"Stop"/"cancel" targets the mapped current run (or its queued turn) through the existing authorized canonical cancellation API. Report accepted cancellation versus confirmed terminal state accurately. Dismissal alone does not cancel work. Touch Chat stream subscriptions at least once a minute (default TTL is five minutes), preserve/replay cursors and refetch current state on replay gaps; dispose subscriptions/timers on shutdown. Never replay completed work to restore a card.

The voice model generates its own acknowledgements; `delegate.ts` never sends placeholder commentary (research finding 1).

### Direct actions (`actions.ts`)

Use strict bounded action schemas, owner authorization and the installed app registry. Keep the Desktop fuzzy resolver in its owning layer; reuse it for name ambiguity and revalidate the resulting installed slug on the gateway before sending the final authorized UI command. A correlated result from the invoking shell must confirm the actual window effect before Aoede says "opened"/"closed"; broadcast delivery alone proves neither. Other tabs, duplicate/late acknowledgements and superseded sessions cannot resolve the pending action. Close-app needs explicit acknowledgement wiring: no such contract exists today. Ambiguous targets ask for clarification; failures/timeouts do not claim success.

Notes use `AppRegistry.getSchema("notes")` and existing app DB access, not guessed schema names. Writes preserve both markdown `content` and Tiptap `content_json`, plus timestamp and existing formatting. An append/edit reads and updates under a Kysely transaction/row lock using the existing app DB handle; `QueryEngine` has no transaction API and its void `update()` alone cannot prove a row changed. Verify the resulting row, notify existing data-change subscribers and render the note in browser qualification. Facts reuse atomic owner profile-file persistence and existing caps, including old `vocal-profile.json` data.

### Shell events

Extend existing `ServerMessage`/`useSocket` contracts and `broadcastToOwner` with bounded `aoede:*` messages for UI resolve/execute/result, cards, approval questions/decisions and supersession. Include application session ID and correlation ID; only the invoking shell applies session UI commands. Reuse existing socket authentication, send isolation, eviction and shutdown drain. No `/api/aoede/events`, new query-token allowance, or second subscriber registry. Backend cards rebuild from canonical Chat state after socket reconnect.

### Prompt split

- **Live prompt** (`aoede/prompt.ts`, ≤600 tokens): persona (ported from `vocal/prompt.ts`), spoken style, delegate-on-action rule, what it may answer itself (small talk, clarifications), profile facts.
- **Backend**: the kernel's existing prompt + a short "voice context" preamble on the admitted turn: transcripts are imperfect; reply with facts, status, next step in ≤3 spoken sentences; report success only after tools confirm.

### Platform

Reuse `speech/routes.ts` runtime identity and `buildPlatformSpeechRuntimeVerificationToken`, including machine ID, slot and current token epoch; do not copy the Gemini proxy's handle-only token/fallback. Reuse its upgrade transport mechanics only. Gate on valid enabled speech configuration and an explicit Live model/rate/duration policy; speech is disabled by default. Existing config/funding is transcription-specific (including credential scope): extend it explicitly for Live without broadening transcription authority or silently treating Live as `speech:transcribe`.

Use `SpeechFundingPort.reserve/start/settle/release` and existing platform operation/reservation persistence. Reserve the cap before dispatch, keep network I/O outside transactions, extend in-flight reservation lifetime to cover the enforced cap/finalization, and settle idempotently from provider events observed on the platform sideband. `session.usage.updated` is cumulative: replace snapshots, never sum them. Only `session.closed.usage.seconds` confirms final usage. WebRTC initialization bills 15 seconds credited against running duration, not an additional 15 seconds. Creation failure before dispatch releases funds; timeout after dispatch is uncertain, may incur initialization cost and must not trigger automatic remint/refund. Apply conservative settlement through the existing funding port when finalization is unconfirmed; preserve that status rather than recording an exact zero. Provider creation succeeded but DB/attach failed requires compensating closure, not free execution.

No browser/gateway-reported seconds as billing authority, no separate usage wallet/table and no unbound internal attach credential. Platform restart/shutdown must retain operation state and conservatively finalize unfinished funded sessions; gateway restart recovery cannot be the only billing cleanup path. Missing finalization does not prove upstream billing stopped: reconcile the existing operation and block another mint for that unresolved session until termination/accounting policy can safely resolve it.

### Shell

`useAoedeSession.ts` manages media tracks/peer cleanup, not a custom audio engine. Use `getUserMedia`, peer tracks and an audio element for playback; data channel for captions/lifecycle, existing `useSocket` for cards and authorized UI effects. Reuse Desktop's real open/focus/close handlers, not `os-bridge.openApp` as though it were an acknowledged gateway API. Preserve `useVocalStore` visibility wiring in Desktop and AoedeDockButton; keep state serializable and selectors stable. Mount one overlay for Desktop/Canvas and update the existing palette/hotkey action; deliberately remove the `VOICE_HIDDEN` gate only once wired and qualified.

`AoedeOverlay.tsx`: mounted once at shell root behind a `visible` flag; `role="dialog"`, focus trap, Esc, focus restore; halo + orb (orb level from output transcript cadence, not audio analysis, to avoid an AnalyserNode — revisit if it looks flat); captions; cards. `prefers-reduced-motion` → static.

## Phases

1. **Lifecycle first (US1):** boundary contracts, explicit Live config/funding policy, authenticated funded REST mint and platform sideband, bounded transcripts/checkpoint, greeting, close/final settlement and fresh-session recovery. Re-host the existing overlay/store on WebRTC before adding actions. TDD covers another owner's session, stale runtime token, unfunded/disabled mint with no provider dispatch, duplicate invocation, compensation and exact-once/conservative settlement. Qualify real startup/close ordering before proceeding.
2. **Direct actions (US2):** owner-registry resolution, acknowledged UI effects, actual SQL Notes persistence/rendering and profile preservation. Prove ambiguous/uninstalled app makes no window effect, note append preserves prior rich text, duplicate/late acknowledgements cannot claim success, and remembered facts survive a new session.
3. **Canonical Chat (US3/4):** real admission/queue/revision retry, persisted delegation mapping, event replay/touch, cancellation and authenticated HTTP approvals. Exercise the production orchestrator with disposable owner SQL; prove duplicate delegation admits once, cross-owner work never starts, stale/ambiguous voice cannot approve, missing proof cannot permit a tool, long builds still deliver completion, and recovery does not rerun finished work.
4. **Replacement and docs:** remove old transport/panel only after rewiring all consumers and auth/route inventory. Keep profile/store; port styling. Update repo developer docs and prepare a separate PR for `FinnaAI/matrix-os-site/content/docs/` covering invocation, permissions, billing, recovery and troubleshooting. Delete the throwaway spike only after qualification no longer needs it.
5. **Qualification and delivery:** run typecheck, pattern scan, focused tests and React Doctor for React changes, then browser Desktop/Canvas checks with inspected screenshots for default, denied-mic, superseded/recovery, build/approval and reduced-motion states. Validate SC-001..008 on the production-parity `dev:full` path from #2040; a local spike or fixture is not that evidence. Preview VPS validation requires deployment authorization. After #2040 lands, update this branch from upstream main, check any squash-merge effects/conflicts, rerun relevant checks and open the Aoede PR only with authorization. Do not merge into the #2040 branch or push/open PRs as part of plan correction.

Only retain tests that prevent a named user-visible, domain, security or data-integrity regression. No dependency/schema field tests, source-string/identity/class-name assertions, markup snapshots or helper-vs-helper comparisons. Expected outcomes are independent of implementation. Required SQL/container setup fails visibly; fake provider I/O is not proof of live service correctness. Browser interaction and rendering checks are separate from unit results.

### Provider qualification gates (not executed by this plan update)

- With explicit paid-call authorization, measure at least a six-minute session, actual `expires_at`, startup ordering and the application-duration close. The two short spike sessions do not establish SC-001.
- Disconnect sideband while WebRTC stays live; verify attach receives only subsequent events. Restart gateway/platform and prove fresh-session recovery, no duplicate mutation/admission, and finalization/settlement cleanup.
- Measure delegation offset versus final transcript fragment across roughly 20 utterances; tune the grace using results. Output caption arrival is not proof that the user's turn is complete.
- Complete a long task against an old delegation ID and test the correlated error/null-context fallback; transport failure alone must not resend commentary and create duplicates.
- Exercise explicit close, peer teardown and failed mint/attach; capture `session.closed` versus missing finalization and the corresponding wallet outcome. Record language, interruption, silence and device-switch behavior rather than inferring it from API support.

## Risks

| Risk | Mitigation |
|---|---|
| Kernel cold start | Report real admission/progress; builds continue in Chat. Measure perceived latency, do not invent completion. |
| Classifier ambiguity or incomplete transcript | Ask for clarification or route through Chat; never mutate from an uncertain interpretation. |
| False voice approval | One presented low-risk approval and explicit utterance only; higher/unknown risk requires click; authenticated HTTP proof remains mandatory. |
| Sideband proxy adds latency or misses startup | Qualify ordering and acknowledgements; no unsupported attach credential or claim that latency is irrelevant. |
| Expiry/restart loses recent speech or events | Explicit fresh session with bounded saved history/current task state; unknown actions are not replayed. No seamless-reconnect guarantee. |
| Funding TTL/config is transcription-specific | Extend the existing Live operation policy explicitly and prove reservation bounds/cleanup before dispatch is enabled. |

## Evidence

Local source: `chat/orchestrator.ts`, `contracts/src/canonical-chat-api.ts`, `bots/continuations.ts`, `chat/claude-custom-mcp-approval.ts`, platform `custom-mcp-approval-proof.ts`, `speech/{routes,service,funding,config}.ts`, `chat/event-stream.ts`, `app-db-query.ts`, Notes `notes-model.ts`/`RichEditor.tsx`, Desktop/store/socket wiring. These verify existing contracts, not the proposed integration.

Authoritative provider sources: [REST creation](https://developers.openai.com/api/reference/resources/live/methods/create), [sideband/no replay](https://developers.openai.com/api/reference/resources/live/sideband-websocket), [session history and graceful close](https://developers.openai.com/api/docs/guides/live-conversations), [billing](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live). The review's upstream issue search found no relevant replay/duration issue; absence of a result is not proof of reliability. The [OpenAI console](https://github.com/openai/openai-live-console) is a reference, not evidence that Matrix's runtime works.

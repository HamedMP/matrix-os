# Chat presentation, voice history, and onboarding audit

## Scope and design source

Read the [Desktop app onboarding page](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1164-9060) Cover first, then sections 1–9 and the notes below their frames. The ordered audit used Figma MCP metadata and representative flow screenshots/context, including the full Chat child frame `1164:18918` and corner widget `1176:1715`. Archive is excluded. This is an implementation audit, not full visual qualification of every frame.

The voice preview and typography correction did **not** implement the complete chat-first onboarding MVP. The current change aligns the existing Chat presentation across Web Canvas, Web Desktop, and Electron Desktop; gives voice conversations a durable history category; and titles them from committed opening messages or session completion. Existing Electron coding starter actions remain ordinary Chat actions. They are not the four onboarding task paths.

## Cover and sections 1–9

| Section | Required experience | Current implementation / gap |
|---|---|---|
| Cover | Real first result in about two minutes, app connection only when needed | Not qualified; the voice preview alone cannot satisfy this acceptance criterion. |
| 1 — First run | Personalized greeting, exact three lines, Research / Plan / Build website / Work on code, scoped app tags, Connect apps first, Matrix AI · Change, same full Chat | Missing. Existing coding starter cards are shared between desktop clients but are not onboarding task choices. |
| 2 — Connect apps first | Inline searchable apps list, Connect / Connected / Done, ready task tags on return | Missing in the widget. Settings connection capabilities are not this inline flow. |
| 3 — Plan my week | One short question/chips, Calendar Connect/Skip, work checks, result Open, one recurring follow-up | Missing as an onboarding path. |
| 4 — Research anything | Short topic question, bounded work log, brief Open, one watch offer | Missing as an onboarding path. |
| 5 — Build a website | Short brief/chips, actual build and Open, one editing offer | General task delegation exists; the exact onboarding path and result acceptance are missing. |
| 6 — Work on my code | Scoped GitHub connection, recent repos / link, ready next-job chips, Claude Code · Change | Missing as an onboarding path. |
| 7 — Change AI | Matrix AI / Claude / ChatGPT-Codex menu, account/key/wait/retry states, return to tasks | Settings route controls exist; shortened inline onboarding connection flow is missing. |
| 8 — Exceptional states | Startup task queue, visible failed step and simpler retry, failed sign-in, minimized working/result badge, credits only after result | Voice readiness/retry/draft preservation exists. The task-first exceptional states and result badge lifecycle are missing. |
| 9 — Three sizes | One conversation, bubble ⇄ corner ⇄ full Chat; lifecycle controlled by first task completion and user choice | Saved conversation and corner-to-Chat handoff exist. Full first-task auto-open policy and working/completed bubble semantics are missing. |

The missing onboarding paths must ship with real app permissions, connected-app state, durable task/result state, exact frame copy, keyboard access, and tests. Do not simulate connection or completed work with timed UI messages. The onboarding completion record must follow a real successful first task, not widget dismissal or microphone use.

## Shared presentation

`@matrix-os/brand` owns the verified Geist face and Figma paper, ink, border, muted and secondary tokens. `ChatPresentation`, `ChatHistory`, `ChatStarterCards`, the rabbit avatar, and Hugeicons geometry live in `@matrix-os/ui`. Web Chat and Electron Chat compose these shared components; native window chrome may adapt. Transcript and composer semantics remain canonical. The corner widget uses the same brand tokens, avatar, icon geometry and stable caption type through streaming/completion. Shared starter cards own their grid, spacing and type in the shared stylesheet, so a renderer’s utility-class scan cannot remove their layout. The Electron assistant launcher also uses the rabbit avatar.

Web and Electron preserve editable offline drafts, exact harness/access-source selection, attachments, approval/input controls, search, unread/read actions, rename, deletion confirmation and same-conversation selection. This presentation work does not claim completed onboarding, universal app automation, or physical microphone qualification.

## History and title invariants

- Canonical Chat in owner-controlled Postgres is the sole source of history. `conversation_kind` is `chat` or `voice`; no second voice database is introduced.
- Only the server-owned companion bootstrap creates a `voice` conversation. Public create requests cannot choose another lifecycle/category or supply ownership.
- The additive migration uses durable `aoede_bootstrap_requests` ownership/provenance to classify existing assistant conversations. It never guesses from a title or ID. Manual renames survive; existing committed opening messages supply topic titles in bounded migration batches. Empty or greeting-only legacy “Aoede” conversations become “Voice conversation.”
- HTTP and SSE metadata version 2 expose the category to new clients. Versions 0 and 1 strip the additive field for older strict clients while retaining their existing title/read/message compatibility projections.
- List/search default to ordinary chats. Explicit `conversationKind=voice` retrieves voice history; `all` lets the desktop clients retain both histories. Filtering precedes pagination and limits. Direct authorized Chat IDs, exports and deletions continue to address the same saved record.
- Web Chat and standalone Electron Chat expose separate history tabs. Electron's main Work navigation keeps voice records out of Pinned / Projects / Recents and exposes a separate Voice conversations section. Task delegation creates ordinary task Chats.
- Titles use the first meaningful owner message among the first three committed user messages. The first completed exchange or opening 2–3 messages can title a conversation; session close handles a single committed utterance. Small talk and assistant text are excluded. Titles are bounded and generated locally without an inference call or personal AI subscription.
- Transcript insertion/title changes and their outbox invalidation share one transaction. Row locks and conditional revision/title writes protect manual titles and replay. Automatic title version changes once; subsequent messages do not keep changing it.
- Title generation and history do not change platform-paid voice funding or task funding.

## Existing endpoint authority

| Endpoint | Authentication and authority | Public |
|---|---|---|
| GET `/api/chats` / `/api/chats/search` | Existing gateway principal; owner-scoped query; strict category enum and bounded query/limit/cursor | No |
| GET `/api/chats/:id` | Existing principal and canonical Chat access checks | No |
| PATCH title and read state / DELETE Chat | Existing owner access, strict payload/body limits and canonical CAS/tombstone behavior | No |
| Native voice session / companion bootstrap | Existing principal, private owner Chat, current platform readiness/funding and bounded session | No |

No new unauthenticated endpoint, provider credential, external title fetch, or raw audio persistence is added. A category filter cannot grant access to another owner's record.

## Extraction and verification

The large Chat repository remains a composition entrypoint: indexed search/category selection is extracted to `search-repository.ts`, migration to `voice-history-schema.ts`, and automatic voice title operations to `voice-title.ts`. Electron manual title orchestration is extracted to `use-canonical-chat-title.ts`. Shared history and starters replace renderer-specific presentation rather than adding another store.

Regression checks cover real PGlite migration, owner isolation, filtering before pagination, default/voice/all list and search, greeting boundaries, bounded titles, session-finish naming, replay, manual rename preservation, ordinary Chat used with voice, route validation, keyboard tab navigation, search/read actions and failed rename drafts. Existing host tests exercise Web Chat and Electron Chat wiring, including Electron Work navigation. Production Web and Electron builds are required before deployment. Physical Electron audio acceptance is a separate release gate.

Public documentation is updated separately in the private `FinnaAI/matrix-os-site` repository (Aoede preview documentation PR). Release status must distinguish implementation checks from deployment and actual user interaction evidence.

Production loading is checked without TypeScript development path remapping. The shared title helper uses the contracts package's native Node import map, and the host bundle smoke check loads contracts and the terminal runtime in a separate native Node process before publication.

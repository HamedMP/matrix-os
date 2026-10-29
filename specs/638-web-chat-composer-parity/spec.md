# 638: Web Chat composer parity with Electron Desktop

Linear: [ENG-409](https://linear.app/matrix-os/issue/ENG-409/match-web-chat-composer-to-electron-desktop)
Related: ENG-217 (shared Desktop Chat composer), ENG-368 (Web/Electron Chat UI alignment)

## Goal

Web Chat's prompt box looks and behaves like Electron Desktop's, built from the
same `packages/ui` parts instead of copies.

## Affected surfaces

Web Desktop, Web Canvas, Web Mobile (all render `shell/src/components/ChatApp.tsx`),
Electron Desktop (moves its composer parts into `packages/ui`; no intended visual change).
Native Mobile: N/A (separate React Native composer).

## Behavior

- **New Chat**: Electron's screen, shared from `packages/ui`: Matrix logo, "What should
  we build today?", and four starter cards that fill the draft.
- **Column and focus**: the composer sits in Electron's 808px column for new and
  existing Chats, and focus uses Electron's dark border with a light ring.
- **Card layout**: one card with a tall input and a toolbar row below it.
  Placeholder is "Reply to chat…" in a conversation and "How can I help you today?"
  on the empty state. The unavailable/connecting hint stays.
- **Mic**: the shared mic control, as on Electron. Recording state shows on the
  control (label, waveform, timer), not in the placeholder, and the mic is off
  while a run is active unless the draft can be queued.
- **Toolbar, left**: attach (+) when the harness accepts files. The Drive context
  control stays above the card, where Electron renders it.
- **Toolbar, right**: mic, model picker, Agents & providers settings, composer
  options (effort), permission mode (access), then Send or Stop.
  Under 42rem container width, effort and access collapse into a "Chat settings"
  popover, like Electron.
- **Header**: the model button, setup panel, and Execution options leave the Web header.
  Interaction mode and `advanced` options are no longer shown on Web, matching
  Electron; saved values are kept.
- **Send/Stop**: while a run is active, Stop shows unless the draft can be queued
  (Web queues Agent-mention turns only); then Send queues it. Same rule as Electron.
- **Queue**: queued turns render attached above the card with Steer, delete, and a
  menu, like Electron. Steer uses the existing
  `POST /api/chats/:chatId/runs/:runId/queued-turns/:queuedTurnId/steer` route and is
  enabled only when the active run reports `steering: "same_run"`.
  On Web the menu's Edit item is disabled and drag reorder is not shown.

## Shared parts (`packages/ui/src/chat/composer/`)

`ChatPromptInput` (card + toolbar + Send/Stop), `ChatComposerSelect` (compact
picker), `ChatModelPicker` (trigger + catalog popover + settings button),
`QueuedTurnsPanel`, and `chat-composer.css`. Electron re-exports them from its
existing paths. Colors come from shared tokens with composer-scoped overrides
(`--composer-*`) so the shell's shadcn `--accent` does not leak into Send.

## Out of scope

Editing or reordering queued messages on Web; queueing plain-text turns on Web;
Electron's project context picker on Web (Web has no move-Chat-to-Project API).

## Documentation

Separate PR in `FinnaAI/matrix-os-site` under `content/docs/` describing the
composer toolbar (model, effort, access) and queued-message Steer/delete on Web.

## Acceptance

- Unit: shared parts render the toolbar row, Send/Stop rule, queue actions;
  Web ChatApp shows model/effort/access in the composer toolbar, not the header;
  Steer calls the steer route with `expectedTurnId` and `baseRevision`.
- Live: side-by-side captures of Web Desktop, Web Canvas, Web Mobile, and Electron
  Desktop for empty, typing, running, and queued states.

## Security / failure modes

Steer is an existing authenticated gateway route; the shell client validates ids
with the contract schemas before building the URL and uses the shared request
timeout. A failed steer logs the error name only and shows a generic message;
the queue stays as last loaded. No new persistence or in-memory state.

## Risks

Removing Web-only Interaction mode and advanced options from the UI is a visible
change for Web users who used them; Electron has never shown them.

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
- **Toolbar, left**: attach (+) when the harness accepts files, then Electron's
  project folder button. On a new Chat it picks the project the Chat is created in
  (`POST /api/chats` with `projectId`); on an open Chat it moves the Chat
  (`PATCH /api/chats/:chatId/project` with the Chat's `baseRevision`) and is off
  while a run is active. A Chat whose project is not in the list shows it as
  unavailable. The picked draft project is scoped to the computer and owner and
  clears on New chat. The Drive context control stays above the card, where
  Electron renders it.
- **Toolbar, right**: mic, model picker, Agents & providers settings, composer
  options (effort), permission mode (access), then Send or Stop.
  Under 42rem container width, effort and access collapse into a "Chat settings"
  popover, like Electron.
- **Header**: Electron's pane title. The Chat name sits on the left at 15px medium
  and renames on click; a new Chat shows no title. The model name, bot badge, and
  divider line leave the header, as do the model button, setup panel, and
  Execution options. Interaction mode and `advanced` options are no longer shown
  on Web, matching Electron; saved values are kept.
- **Type and rendering**: the composer and its menus use Electron's type scale
  (11/12/13/14px) and Web Chat renders text antialiased, as Electron does.
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
`ChatProjectContextPicker` (folder button; hosts supply the project list),
`QueuedTurnsPanel`, and `chat-composer.css` (geometry, type scale, and the
`matrix-chat-composer-menu` class for portaled menus). Electron re-exports them from its
existing paths. Colors come from shared tokens with composer-scoped overrides
(`--composer-*`) so the shell's shadcn `--accent` does not leak into Send.

## Out of scope

Editing or reordering queued messages on Web; queueing plain-text turns on Web;
creating a project from the Web picker (the empty list explains instead).
The Chat sidebar (Search row, Shared with me, Pinned, counts, shortcuts) is a
separate follow-up: it is navigation, not the composer.

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

Steer and project moves use existing authenticated gateway routes; the shell
client validates ids and bodies with the contract schemas before building the URL
and uses the shared request timeout. A failed steer or move logs the error name
only and shows a generic message; a failed move reloads the Chat. A move or steer
that settles after the user switched Chats or computers is ignored. The project
list parses `kind`/`github` as display-only fields that fall back on unknown
values. No new persistence or in-memory state.

## Risks

Removing Web-only Interaction mode and advanced options from the UI is a visible
change for Web users who used them; Electron has never shown them.

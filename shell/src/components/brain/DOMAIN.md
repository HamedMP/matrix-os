# Company Brain app: Web adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563) to the Web gateway client for Web Desktop,
Web Canvas and Web Mobile. Its rules, client and screens are in `packages/ui/src/brain/DOMAIN.md`.

## Scope

- `BrainApp.tsx`: the shared `BrainApp` bound to `shellApi`, plus the chat slot; `ShellBrainAppProps` omit `api`,
  `loadProjects` and `chat`, and add `mobile`, `active` and `visible` (both required). The windows pass the same
  `active` (focused and shown) and `visible` (not minimized) as the Chat window, so the chat marks answers read only
  while it is seen.
- `BrainChatHost.tsx`: the Web chat slot. It fills the Chat tab with the shell's own `ChatApp` in `layout="embedded"`
  (no rail, suggestion chips, Share, settings or connection line; the same transcript, composer, Bot panel and model
  recovery notice), driven by `hooks/useCanonicalChatThread.ts`: a controller for one Chat that reuses the Chat app's
  transcript, content deltas and snapshot refresh, calls the slot's `createChat` on a draft's first send, never changes
  the URL or the Chat app's selection, and reports the Chat after every admitted turn. The Bot comes from the slot
  (`botId`), so a draft already sends as the Bot, and a Bot chat shows no harness setup (a Bot runs on its own model).
  When a new thread's first turn is refused, the question moves into its composer, kept by the host even after a switch
  away and put in front of a question typed there since (neither is lost), and the refusal stays shown through later
  refreshes until the next send. A question with a reference sent while an answer runs is queued, as in the Chat app,
  and a retry keeps its queue. A thread switch remounts the view, so
  the host keeps the composer drafts (`composerDrafts`): each thread's unfinished question and references, and each
  project's draft (`newDraftScope`), come back when the viewer returns; a question sent before a switch leaves them once
  it is admitted. Like the Chat app, it follows the shell chat authority (`useCanonicalChatAuthority`): no slot while
  the chat state withholds the agent client, Bot reads over its guarded summary client, and the view keyed by
  `authorityKey` and given `composerIdentity`, so a new owner never gets the previous owner's transcript or drafts,
  while the owner's own drafts stay through a new authority (the brain chat then opens as it does at first); Open in
  Chat, rename and delete are refused once the authority has moved on. Open in Chat switches the Chat app to the same
  Chat and focuses or opens its window through `lib/shell-window-focus.ts` (Web Canvas pans to it). Rows rename and
  delete over the shell chat client.
- The built-in window `__brain__`: `lib/builtin-apps.ts`, `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx`
  (no heading, the title bar names the app), `mobile/MobileShell.tsx` (`mobile`), `ShellHome.tsx`, the taskbar, the
  palette in `Desktop.tsx`, `lib/web-desktop-app-launch.ts` and the minimum size in `hooks/useWindowManager.ts` (which
  reads `BRAIN_SHELL_VIEW` from `@matrix-os/ui`, not from here: the brain app imports the window store).

## Source Of Truth

- The gateway, through the shared view. Only unsent composer drafts are kept here, in memory, while the app is open, for
  one owner. The client and the one event stream come from the shell chat state (`useCanonicalChatState` returns them as
  `chatRuntime`), so the shell still opens one stream.

## Public API

- `@/components/brain` (`index.ts`, the only entry point): `BrainApp`, `ShellBrainAppProps`, `BRAIN_SHELL_VIEW`,
  `BRAIN_SHELL_SCREENS`, `BRAIN_APP_KEYWORDS`, `brainShellError`, `createBrainShellApi`, `listBrainProjects`, types.
  Outside a `ChatProvider` (tests, an older host) the Chat tab says chat is not available here.

## Auth And Trust Boundaries

- The same-origin gateway session (`shellApi`); `ClientApiError` carries the category and code. Deletes send no body.

## Concurrency And Recovery

- As in the shared view; the client is created once per page. The thread view drops a snapshot answer meant for an
  older request, falls back to a snapshot on a content gap, and polls every 2 s while an answer runs without an open
  stream, each poll after the one before.

## Tests

- `tests/shell/`: `brain-shell.test.tsx`, `canonical-chat-thread.test.tsx` (the thread hook, one poll at a time, the
  embedded layout, a draft sent as a brain thread, a refused first question given back, drafts kept across thread
  switches and a sent one not brought back, drafts never given to a new owner, no slot while the agent client is
  withheld, nothing opened, renamed or deleted after an authority change, read state only while seen, Open in Chat),
  `chat-composer-draft.test.tsx` (the draft keeper), `canonical-chat-client.test.ts` (the Chat delete),
  `builtin-apps.test.ts`, `web-desktop-app-launch.test.ts`, `window-manager.test.ts`.

# Company Brain app: Web adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563) to the Web gateway client for Web Desktop,
Web Canvas and Web Mobile. Its rules, client and screens are in `packages/ui/src/brain/DOMAIN.md`.

## Scope

- `BrainApp.tsx`: the shared `BrainApp` bound to `shellApi`, plus the chat slot; `ShellBrainAppProps` omit `api`,
  `loadProjects` and `chat`, and add `mobile`.
- `BrainChatHost.tsx`: the Web chat slot. It fills the Chat tab with the shell's own `ChatApp` in `layout="embedded"`
  (no rail, suggestion chips, Share, settings or connection line; the same transcript, composer, Bot panel and model
  recovery notice), driven by `hooks/useCanonicalChatThread.ts`: a controller for one Chat that reuses the Chat app's
  transcript, content deltas and snapshot refresh, calls the slot's `createChat` on a draft's first send, never
  changes the URL or the Chat app's selection, and reports the Chat after every admitted turn. The Bot comes from the
  slot (`botId`), so a draft already sends as the Bot. Open in Chat switches the Chat app to the same Chat and focuses
  or opens its window through `lib/shell-window-focus.ts` (Web Canvas pans to it). Rows rename and delete over the
  shell chat client.
- `index.ts`: the one entry point for shell code.
- The built-in window `__brain__`: `lib/builtin-apps.ts`, `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx`
  (no heading, the title bar names the app), `mobile/MobileShell.tsx` (`mobile`), `ShellHome.tsx`, the taskbar, the
  palette in `Desktop.tsx`, `lib/web-desktop-app-launch.ts` and the minimum size in `hooks/useWindowManager.ts`.

## Source Of Truth

- The gateway, through the shared view. Nothing is stored here. The client and the one event stream come from the
  shell chat state (`useCanonicalChatState` returns them as `chatRuntime`), so the shell still opens one stream.

## Public API

- `@/components/brain`: `BrainApp`, `ShellBrainAppProps`, `BRAIN_SHELL_VIEW`, `BRAIN_SHELL_SCREENS`,
  `BRAIN_APP_KEYWORDS`, `brainShellError`, `createBrainShellApi`, `listBrainProjects` and the client types. Outside a
  `ChatProvider` (tests, an older host) the Chat tab says chat is not available here.

## Auth And Trust Boundaries

- The same-origin gateway session (`shellApi`); `ClientApiError` carries the category and code. Deletes send no body.

## Concurrency And Recovery

- As in the shared view; the client is created once per page. The thread view drops a snapshot answer meant for an
  older request, falls back to a snapshot on a content gap, and polls every 2 s while an answer runs without an open
  stream.

## Tests

- `tests/shell/`: `brain-shell.test.tsx`, `canonical-chat-thread.test.tsx` (the thread hook, the embedded layout, a
  draft sent as a brain thread, Open in Chat), `canonical-chat-client.test.ts` (the Chat delete), `builtin-apps.test.ts`,
  `web-desktop-app-launch.test.ts`, `window-manager.test.ts`.

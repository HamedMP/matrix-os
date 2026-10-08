# Company Brain app: Web adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563; its `DOMAIN.md` has the rules, client and
screens) to `shellApi`, the same-origin gateway session, for Web Desktop, Web Canvas and Web Mobile. It stores nothing;
the client is made once per page, `ClientApiError` carries the category and code, and deletes send no body.

- `index.ts` (the only entry): `BrainApp`, `ShellBrainAppProps` (no `api`, `loadProjects` or `chat`; adds `mobile`),
  `BRAIN_SHELL_VIEW`, `BRAIN_SHELL_SCREENS`, `BRAIN_APP_KEYWORDS`, `brainShellError`, `createBrainShellApi`,
  `listBrainProjects`, types. Outside a `ChatProvider` (tests, an older host) the Chat tab says chat is not available.
- `BrainChatHost.tsx`: the Web chat slot. It fills the Chat tab with the shell's own `ChatApp` in `layout="embedded"`
  (no rail, suggestion chips, Share, settings or connection line; the same transcript, composer, Bot panel and model
  recovery notice), driven by `hooks/useCanonicalChatThread.ts`: a controller for one Chat that reuses the Chat app's
  transcript, content deltas and snapshot refresh, calls the slot's `createChat` on a draft's first send, never
  changes the URL or the Chat app's selection, and reports the Chat after every admitted turn. The Bot comes from the
  slot (`botId`), so a draft already sends as the Bot. Open in Chat switches the Chat app to the same Chat and focuses
  or opens its window through `lib/shell-window-focus.ts` (Web Canvas pans to it). Rows rename and delete over the
  shell chat client.
- The client and the one event stream come from the shell chat state (`useCanonicalChatState` returns them as
  `chatRuntime`), so the shell still opens one stream. The thread view drops a snapshot answer meant for an older
  request, falls back to a snapshot on a content gap, and polls every 2 s while an answer runs without an open stream.
- The window `__brain__`: `lib/builtin-apps.ts`, `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx` (no heading),
  `mobile/MobileShell.tsx` (`mobile`), `ShellHome.tsx`, the taskbar, the palette in `Desktop.tsx`,
  `lib/web-desktop-app-launch.ts` and the minimum size in `hooks/useWindowManager.ts`. Tests in `tests/shell/`:
  `brain-shell.test.tsx`, `canonical-chat-thread.test.tsx` (the thread hook, the embedded layout, a draft sent as a
  brain thread, Open in Chat), `canonical-chat-client.test.ts` (the Chat delete), `builtin-apps.test.ts`,
  `web-desktop-app-launch.test.ts` and `window-manager.test.ts`.

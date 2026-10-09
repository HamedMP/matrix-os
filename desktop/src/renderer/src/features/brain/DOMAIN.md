# Company Brain app: Electron Desktop adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563) to the Electron Desktop gateway client. The
product rules, the client and the screens are documented in `packages/ui/src/brain/DOMAIN.md`.

## Scope

- `brain-transport.ts`: the desktop `ApiClient` as the view's transport. The desktop delete always sends a JSON body,
  so `delete` goes as `api.delete(path, {}, options)`; the brain routes accept an empty object. The two desktop-only
  error categories map to their nearest state: `fatalSession` to `unauthorized`, `misconfigured` to `offline`.
- `DesktopBrainView.tsx`: the view over `api.forRuntime(runtimeSlot)`, without the in-app heading (the window title
  bar names the app). Without a gateway session it shows "Connect to your Matrix computer to open the Company Brain."
  It wraps the view in the tab's chat runtime (`WorkSurfaceRuntimeProvider`, streaming only while the tab is visible).
- `DesktopBrainChat.tsx`: the Electron Desktop chat slot. It fills the Chat tab with `CanonicalChatWorkspace` (the same
  transcript, composer, Bot panel and event stream as the Chat tab) with `externalNavigation`, so it never opens a Chat
  tab on its own; `botId` makes a draft send as the Bot, `createChat` makes the draft's thread on its first send,
  `draftWelcome` (the slot's heading and line) replaces the starter cards and the harness setup. With `createChat` or
  `botId` the workspace shows no project picker and no Share, as on Web. It passes on every report the workspace makes
  (after each admitted turn, the first one in a reopened chat included). The Chat it shows follows those reports, not
  the slot, so a refused first question stays in the draft's composer with the error. An opened thread stays selected
  when the chat list's first page leaves it out, so its events and polling keep it live. Each project's brain draft has
  its own key (`newDraftScope`), never the Chat tab's new-chat draft. Open in Chat opens the Chat tab on the same Chat;
  rows rename and delete over the tab's chat client.
- Registration: tab kind `brain` (`stores/tabs.ts`, one tab like Notes), the fixed app `__brain__` after Whiteboard
  (`desktop-shell/desktop-apps.ts`; in the launcher, not placed on the desktop by default), its opener in
  `NativeDesktopShell.tsx`, `TabContent.tsx`, `SurfaceIcon.tsx`, the analytics kind `brain`, the palette entry
  (`BRAIN_APP_KEYWORDS`) and the Tailwind source scan in `design/index.css`. Startup restore and OS-view persistence
  follow from the fixed path.

## Source Of Truth

- The gateway, through the shared view. The remembered project is per surface (`localStorage` of the renderer).

## Public API

- `DesktopBrainView` (default export, rendered by `TabContent` with `visible`), `useDesktopBrainChatHost` and
  `desktopBrainTransport`.

## Auth And Trust Boundaries

- The renderer holds no token: the main process adds it for the gateway origin only. Links with `target="_blank"`
  open in the system browser.

## Concurrency And Recovery

- The view is keyed by runtime slot, auth generation and runtime generation, so a runtime switch or a new sign-in
  remounts it and no answer from the old session can land. Inactive tabs stay mounted, so a followed job keeps
  polling, capped as on Web.

## Tests

- `tests/desktop/brain-desktop-view.test.tsx`, `tests/desktop/brain-chat-tab.test.tsx` (the slot rendered through
  `useDesktopBrainChatHost().render`: a draft made through the host and sent as the Bot, each turn reported once, a
  saved chat opened without its open report and its first turn reported, a refused first question kept, a draft apart
  from the Chat tab's, no project picker or Share, no Chat tab opened on its own, Open in Chat),
  `tests/desktop/canonical-new-chat-content.test.tsx` (the greeting), the Electron Desktop launcher, palette, tab,
  persistence and analytics suites, and `tests/e2e/desktop/company-brain.e2e.test.ts` (needs `desktop/out`).

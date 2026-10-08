# Company Brain app: Electron Desktop adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563) to the Electron Desktop gateway client. The
product rules, the client and the screens are documented in `packages/ui/src/brain/DOMAIN.md`.

## Scope

- `brain-transport.ts`: the desktop `ApiClient` as the view's transport. The desktop delete always sends a JSON body,
  so `delete` goes as `api.delete(path, {}, options)`; the brain routes accept an empty object. The two desktop-only
  error categories map to their nearest state: `fatalSession` to `unauthorized`, `misconfigured` to `offline`.
- `DesktopBrainView.tsx`: the view over `api.forRuntime(runtimeSlot)`, without the in-app heading (the window title
  bar names the app). Without a gateway session it shows "Connect to your Matrix computer to open the Company Brain."
- Registration: tab kind `brain` (`stores/tabs.ts`, one tab like Notes), the fixed app `__brain__` after Whiteboard
  (`desktop-shell/desktop-apps.ts`; in the launcher, not placed on the desktop by default), its opener in
  `NativeDesktopShell.tsx`, `TabContent.tsx`, `SurfaceIcon.tsx`, the analytics kind `brain`, the palette entry
  (`BRAIN_APP_KEYWORDS`) and the Tailwind source scan in `design/index.css`. Startup restore and OS-view persistence
  follow from the fixed path.

## Source Of Truth

- The gateway, through the shared view. The remembered project is per surface (`localStorage` of the renderer).

## Public API

- `DesktopBrainView` (default export, rendered by `TabContent`) and `desktopBrainTransport`.

## Auth And Trust Boundaries

- The renderer holds no token: the main process adds it for the gateway origin only. Links with `target="_blank"`
  open in the system browser.

## Concurrency And Recovery

- The view is keyed by runtime slot, auth generation and runtime generation, so a runtime switch or a new sign-in
  remounts it and no answer from the old session can land. Inactive tabs stay mounted, so a followed job keeps
  polling, capped as on Web.

## Tests

- `tests/desktop/brain-desktop-view.test.tsx`, the Electron Desktop launcher, palette, tab, persistence and analytics
  suites, and `tests/e2e/desktop/company-brain.e2e.test.ts` (needs `desktop/out`).

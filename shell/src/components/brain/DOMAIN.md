# Company Brain app: Web adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563) to the Web gateway client for Web Desktop,
Web Canvas and Web Mobile. Its rules, client and screens are in `packages/ui/src/brain/DOMAIN.md`.

## Scope

- `BrainApp.tsx`: the shared `BrainApp` bound to `shellApi`; `ShellBrainAppProps` omit `api` and `loadProjects`.
- The built-in window `__brain__`: `lib/builtin-apps.ts`, `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx`
  (no heading, the title bar names the app), `mobile/MobileShell.tsx`, `ShellHome.tsx`, the taskbar, the palette in
  `Desktop.tsx`, `lib/web-desktop-app-launch.ts` and the minimum size in `hooks/useWindowManager.ts`.

## Source Of Truth

- The gateway, through the shared view. Nothing is stored here.

## Public API

- `@/components/brain` (`index.ts`, the only entry point): `BrainApp`, `ShellBrainAppProps`, `BRAIN_SHELL_VIEW`,
  `BRAIN_SHELL_SCREENS`, `BRAIN_APP_KEYWORDS`, `brainShellError`, `createBrainShellApi`, `listBrainProjects`, types.

## Auth And Trust Boundaries

- The same-origin gateway session (`shellApi`); `ClientApiError` carries the category and code. Deletes send no body.

## Concurrency And Recovery

- As in the shared view; the client is created once per page.

## Tests

- `tests/shell/`: `brain-shell.test.tsx`, `builtin-apps.test.ts`, `web-desktop-app-launch.test.ts`, `window-manager.test.ts`.

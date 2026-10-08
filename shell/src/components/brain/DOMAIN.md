# Company Brain app: Web adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563) to the Web gateway client for Web Desktop,
Web Canvas and Web Mobile. The product rules, the client and the screens are documented in
`packages/ui/src/brain/DOMAIN.md`; this folder adds no rules of its own.

## Scope

- `BrainApp.tsx`: the shared `BrainApp` with `createBrainShellApi(shellApi)` and `listBrainProjects(shellApi)`.
  `ShellBrainAppProps` are the shared props without `api` and `loadProjects`.
- `index.ts`: the one entry point for shell code (the Web `BrainApp`, the view consts and types).
- Registration of the built-in window `__brain__`: `lib/builtin-apps.ts` (title and aliases), the render branches in
  `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx` (`showHeading={false}`, as the window title bar names the
  app), `mobile/MobileShell.tsx` (heading shown, as the Web Mobile frame has no title bar), `ShellHome.tsx`, the
  taskbar start list, the command palette in `Desktop.tsx` (`BRAIN_APP_KEYWORDS`), the Web Desktop icon list
  (`lib/web-desktop-app-launch.ts`) and the minimum window size in `hooks/useWindowManager.ts`.

## Source Of Truth

- The gateway, through the shared view. Nothing is stored here.

## Public API

- `@/components/brain`: `BrainApp`, `ShellBrainAppProps`, `BRAIN_SHELL_VIEW`, `BRAIN_SHELL_SCREENS`,
  `BRAIN_APP_KEYWORDS`, `brainShellError`, `createBrainShellApi`, `listBrainProjects` and the client types.

## Auth And Trust Boundaries

- Calls use the Web same-origin gateway session (`shellApi`); `ClientApiError` carries the category and code the
  shared view reads. The Web delete sends no body.

## Concurrency And Recovery

- As in the shared view; the client is created once per page.

## Tests

- `tests/shell/brain-shell.test.tsx`, `tests/shell/builtin-apps.test.ts`, `tests/shell/web-desktop-app-launch.test.ts`
  and `tests/shell/window-manager.test.ts`.

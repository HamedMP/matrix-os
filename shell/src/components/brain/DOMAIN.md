# Company Brain app: Web adapter

Binds the shared Company Brain view (`packages/ui/src/brain/`, spec 563; its `DOMAIN.md` has the rules, client and
screens) to `shellApi`, the same-origin gateway session, for Web Desktop, Web Canvas and Web Mobile. It stores nothing;
the client is made once per page, `ClientApiError` carries the category and code, and deletes send no body.

- `index.ts` (the only entry): `BrainApp`, `ShellBrainAppProps` (no `api` or `loadProjects`), `BRAIN_SHELL_VIEW`,
  `BRAIN_SHELL_SCREENS`, `BRAIN_APP_KEYWORDS`, `brainShellError`, `createBrainShellApi`, `listBrainProjects`, types.
- The window `__brain__`: `lib/builtin-apps.ts`, `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx` (no heading),
  `mobile/MobileShell.tsx`, `ShellHome.tsx`, the taskbar, the palette in `Desktop.tsx`, `lib/web-desktop-app-launch.ts`
  and the minimum size in `hooks/useWindowManager.ts`. Tests in `tests/shell/`: `brain-shell.test.tsx`,
  `builtin-apps.test.ts`, `web-desktop-app-launch.test.ts` and `window-manager.test.ts`.

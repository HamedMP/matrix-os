# Desktop Share control parity evidence

Synthetic data only: the browser captures mock the gateway terminal and
system-info routes, and the Electron capture runs against the repository stub
platform. No user, organization or session data appears.

| File | Surface | What it shows |
| --- | --- | --- |
| `web-desktop-terminal-share.png` | Web Desktop | Share in the terminal session header, next to Active |
| `web-desktop-terminal-share-organization.png` | Web Desktop | Share activated without an active organization |
| `web-canvas-terminal-share.png` | Web Canvas | The same session header and Share control |
| `web-canvas-terminal-share-organization.png` | Web Canvas | Share activated without an active organization |
| `web-mobile-terminal-share.png` | Web Mobile | Existing mobile chrome placement, still compact |
| `web-mobile-terminal-share-organization.png` | Web Mobile | Share activated without an active organization |
| `electron-desktop-terminal-share.png` | Electron Desktop | Share enabled after the trusted core resolved the organization |

## How they were captured

- Web: `E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1 next dev` from `shell/`,
  Chromium headless shell at 1440x900 (Web Desktop and Web Canvas) and a
  390x844 touch viewport (Web Mobile), opened with `?launch=__terminal__`.
  The bypass shell has no Clerk session, so it has no active organization;
  those captures show the organization-required explanation.
- Electron: `xvfb-run --auto-servernum pnpm exec vitest run --config
  vitest.e2e.config.ts tests/e2e/desktop/terminal-sharing-organization.e2e.test.ts`
  after `bun run build:desktop`. The stub platform lists one organization
  and advertises collaboration for the runtime.

## Measured geometry (Playwright bounding boxes, CSS px)

| Surface | Share button | Explanation popover |
| --- | --- | --- |
| Web Desktop | x 1160, y 147.5, 63 x 38 | x 935, y 193.5, 288 x 86 |
| Web Canvas | x 1161, y 160.5, 63 x 38 | x 936, y 206.5, 288 x 86 |
| Web Mobile | x 315, y 34.5, 63 x 38 | x 90, y 80.5, 288 x 86 |

# Onboarding widget evidence

Live captures of the onboarding widget from the stack in
[#2524](https://github.com/HamedMP/matrix-os/pull/2524). No credentials, tokens,
or chat contents appear in these images. The full click-through recording with a
real task was shared in the #tech Slack channel.

## Electron Desktop

Captured on 2026-10-12 from a Playwright-driven Electron session signed in to a
real Matrix computer.

- `electron-desktop-widget.jpg`: the widget open beside the main Chat window,
  showing the starter tasks and the active AI in the footer.
- `electron-desktop-ai-menu.jpg`: the AI menu open while Matrix AI is
  available, with Claude and ChatGPT / Codex offered to connect.

## Web Desktop and Web Canvas

Captured on 2026-10-14 from #2523 at `74ea86f06` in headless Chromium at
1440 × 900 against a local gateway, using `bun run dev` with the E2E auth
bypass. No apps are connected, so the app-backed tasks show "Needs Calendar"
and "Needs GitHub".

- `web-desktop-widget.jpg`: the widget in the bottom-right corner of Web
  Desktop, clear of the dock.
- `web-canvas-widget.jpg`: the same widget on Web Canvas, with the canvas
  toolbar and app launcher still reachable.

## Matrix AI unavailable

Captured on 2026-10-14 in headless Chromium at 1440 × 900 against a local
gateway that has no Matrix AI policy, using `bun run dev` with the E2E auth
bypass. The Web mount lands in #2523, so these come from that branch; the
`AiMenu` in `packages/ui/src/onboarding-widget/ai-panel.tsx` is identical there
and is the same component Electron Desktop renders.

- `web-desktop-ai-menu-matrix-unavailable.png` (Web Desktop) and
  `web-canvas-ai-menu-matrix-unavailable.png` (Web Canvas): the Matrix AI row
  is disabled with "Not available on this computer", Claude and
  ChatGPT / Codex stay connectable, and the footer reads "Matrix AI isn't
  available here".

# PR 1748 — immutable Chat harness binding

Current evidence captured from commit `ae4fdc8b8` with a bound Codex Chat and an
available Claude Code alternative. The changed state keeps same-harness model
controls available, disables the other harness, and explains that another
harness requires a new or forked Chat.

| Surface | Evidence |
| --- | --- |
| Web Desktop | [`web-desktop.png`](./web-desktop.png) |
| Web Canvas | [`web-canvas.png`](./web-canvas.png) |
| Web Mobile | [`web-mobile.png`](./web-mobile.png) |
| Electron Desktop | [`electron-desktop.png`](./electron-desktop.png) |

The Web captures use the production shell build and a Playwright-routed
canonical Chat fixture. Electron Desktop uses the production Electron build,
the same canonical fixture, and the repository's Xvfb E2E harness. Both capture
paths assert the exact bound-harness notice before taking the screenshot.

Native Mobile is unchanged by this PR. Its bound-harness picker state and
real-device evidence are deferred to
[#1750](https://github.com/HamedMP/matrix-os/issues/1750). The canonical backend
still rejects cross-instance mutation attempts from every client.

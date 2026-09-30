# Bot settings sidebar evidence

Captured 2026-09-30 through Cua from real Web Desktop, Web Canvas, and built Electron Desktop on the feature working tree based on Pi PR #2048 (`bab5658e`). All data is synthetic. No live Slack, Pi, OAuth, or integration qualification is implied.

## Captures

- [bot-settings-electron-chat.png](bot-settings-electron-chat.png)
- [bot-settings-electron-connections.png](bot-settings-electron-connections.png)
- [bot-settings-electron-memory.png](bot-settings-electron-memory.png)
- [bot-settings-electron-routines.png](bot-settings-electron-routines.png)
- [bot-settings-web-canvas-drawer.jpg](bot-settings-web-canvas-drawer.jpg)
- [bot-settings-web-canvas-memory.jpg](bot-settings-web-canvas-memory.jpg)
- [bot-settings-web-desktop-connections.jpg](bot-settings-web-desktop-connections.jpg)
- [bot-settings-web-desktop-memory.jpg](bot-settings-web-desktop-memory.jpg)
- [bot-settings-web-desktop-routines.jpg](bot-settings-web-desktop-routines.jpg)

## Validation

- 52 shared UI/contracts/Web/Electron tests; 19 Native Mobile tests.
- Strict shared UI, Web, Electron renderer and main-process type checks.
- Production Electron and Web builds pass. Web build retried after removing this task's generated caches to recover disk space.
- Targeted Web lint: no errors, two existing unused-variable warnings. Targeted Native Mobile lint: clean.
- Tests first: initial shared inspector, mutation-cache/focus regressions, native settings and same-ID scope reset had failing tests before implementation.
- Review covered correctness, tests, maintainability, standards, agent accessibility, prior learnings, API compatibility, reliability, adversarial behavior and races. Confirmed cache/focus/scope defects fixed; narrower speculative stale-read race was not reproducible and no extra guard was added. No residual actionable findings.
- Public docs rendered at desktop, 768px and 375px; document scrollWidth equals clientWidth (1274, 762, 369).

## Limits

Fixture gateway intentionally lacks OS-view persistence and the canonical Chat event stream, producing unrelated preview warnings. Native Mobile and Web Mobile settings have component coverage; no device screenshot or full Web Mobile navigation qualification is claimed. Collaboration branch composition stays unchanged; this follow-up does not qualify every upcoming collaboration or agent PR.

# Bot settings sidebar evidence

Captured 2026-09-30 through Cua from real Web Desktop, Web Canvas, and built Electron Desktop on the feature working tree based on Pi PR #2048 (`bab5658e`). All data is synthetic. No live Slack, Pi, OAuth, or integration qualification is implied.

## Initial captures (before Greptile fixes)

- [bot-settings-electron-chat.png](bot-settings-electron-chat.png)
- [bot-settings-electron-connections.png](bot-settings-electron-connections.png)
- [bot-settings-electron-memory.png](bot-settings-electron-memory.png)
- [bot-settings-electron-routines.png](bot-settings-electron-routines.png)
- [bot-settings-web-canvas-drawer.jpg](bot-settings-web-canvas-drawer.jpg)
- [bot-settings-web-canvas-memory.jpg](bot-settings-web-canvas-memory.jpg)
- [bot-settings-web-desktop-connections.jpg](bot-settings-web-desktop-connections.jpg)
- [bot-settings-web-desktop-memory.jpg](bot-settings-web-desktop-memory.jpg)
- [bot-settings-web-desktop-routines.jpg](bot-settings-web-desktop-routines.jpg)

## Initial validation (before Greptile fixes)

- 52 shared UI/contracts/Web/Electron tests; 19 Native Mobile tests.
- Strict shared UI, Web, Electron renderer and main-process type checks.
- Production Electron and Web builds pass. Web build retried after removing this task's generated caches to recover disk space.
- Targeted Web lint: no errors, two existing unused-variable warnings. Targeted Native Mobile lint: clean.
- Tests first: initial shared inspector, mutation-cache/focus regressions, native settings and same-ID scope reset had failing tests before implementation.
- Review covered correctness, tests, maintainability, standards, agent accessibility, prior learnings, API compatibility, reliability, adversarial behavior and races. Confirmed cache/focus/scope defects fixed; narrower speculative stale-read race was not reproducible and no extra guard was added. Subsequent Greptile findings are tracked below.
- Public docs rendered at desktop, 768px and 375px; document scrollWidth equals clientWidth (1274, 762, 369).

## Limits

Fixture gateway intentionally lacks OS-view persistence and the canonical Chat event stream, producing unrelated preview warnings. Native Mobile and Web Mobile settings have component coverage; no device screenshot or full Web Mobile navigation qualification is claimed. Collaboration branch composition stays unchanged; this follow-up does not qualify every upcoming collaboration or agent PR.

## Greptile follow-up, 2026-09-30

PR #2083 remains a draft at the owner's request until real-device Native Mobile validation is complete. The device inventory has no connected iPhone. The Native Mobile review thread remains open; component tests and other surfaces do not substitute for device evidence.

The wide settings panel now overlays the conversation below its toolbar and supports light dismissal, trigger dismissal, and Escape. Empty Connections, Memory, and Routines include an icon, headline, description, and practical hint in the shared renderer and Native Mobile sheet. No new permissions or connections are created.

### Current captures

- [bot-settings-electron-empty-connections.png](bot-settings-electron-empty-connections.png)
- [bot-settings-electron-empty-memory.png](bot-settings-electron-empty-memory.png)
- [bot-settings-electron-empty-routines.png](bot-settings-electron-empty-routines.png)
- [bot-settings-web-desktop-overlay.jpg](bot-settings-web-desktop-overlay.jpg)
- [bot-settings-web-desktop-empty-connections.jpg](bot-settings-web-desktop-empty-connections.jpg)
- [bot-settings-web-desktop-empty-memory.jpg](bot-settings-web-desktop-empty-memory.jpg)
- [bot-settings-web-desktop-empty-routines.jpg](bot-settings-web-desktop-empty-routines.jpg)
- [bot-settings-web-canvas-empty-drawer.jpg](bot-settings-web-canvas-empty-drawer.jpg)
- [bot-settings-web-mobile-empty-memory.jpg](bot-settings-web-mobile-empty-memory.jpg)

### Current validation

- Tests first: the wide outside-click and new empty-state expectations failed before implementation, then passed.
- 54 focused shared UI/contracts/Web/Electron tests and 20 Native Mobile tests pass.
- Shared UI and Electron type checks pass; production Web and Electron builds pass, including the Web build's type check. Targeted Native Mobile lint passes.
- React Doctor 0.9.14 reports zero errors for changed shared/native React files. Its non-blocking warnings concern the existing confirmed-view synchronization effect and native sheet render complexity.
- Full Native Mobile Jest: 391 tests pass across 58 suites; 12 other suites fail to start on the existing micromark ESM import path. This is a failed full-suite gate, not a pass.
- Full Native Mobile type check: 10 errors in unchanged drawer navigation and theme-preference files. Those files and the Jest configuration/contracts entry point are identical to the PR base. No changed native file is reported by the type check.
- Web Desktop: settled conversation width is 1020px both open and closed; Settings trigger bounds remain identical. Outside click closes settings, preserves a typed draft, and trigger toggling works without an accidental reopen.
- Electron Desktop: outside click closes settings and preserves an actually typed draft; all three improved empty states captured in the rebuilt renderer.
- Web Canvas: a normal-sized Chat window uses an aria-modal dialog drawer.
- Web Mobile: actual mobile launcher/Chat inspected at 375×812. Settings and Memory guidance captured; document scrollWidth and viewport are both 375px. This verifies the inspected settings path, not every mobile navigation or mutation flow.

### Surface matrix

| Surface | Settings implementation | Current evidence | Remaining qualification |
| --- | --- | --- | --- |
| Web Canvas | Shared modal drawer / wide overlay | Updated drawer capture; shared behavior tests | Live integrations not exercised |
| Web Desktop | Shared wide overlay / narrow drawer | Updated overlay and three empty-state captures; draft/dismissal checks | Live integrations not exercised |
| Electron Desktop | Shared wide overlay / narrow drawer | Rebuilt Electron captures of all empty states; draft/dismissal checks | Live integrations not exercised |
| Web Mobile | Shared modal drawer | Actual 375px launcher/Chat capture; no document overflow | Full navigation/mutation qualification pending |
| Native Mobile | Native modal sheet, shared copy/actions | 20 focused component tests; lint | Real-device capture/validation pending; full native suite/types have the failures above |

Before changing this PR to review-ready, connect a physical device and validate sheet open/close, section switching, keyboard/safe areas, scrolling, draft preservation, and bot/scope changes. Record device-renderer captures and the commands/results of the required Native Mobile gates. Resolve the Native Mobile evidence thread only after that check succeeds.


## Main rebase and subsequent review fixes

The PR is now based on the Pi integration dependency #2118 rebased onto main `33c53cb24`; earlier screenshots and full-build evidence above precede that rebase. Current Web/shared settings regression passes 31 tests and the focused Native Mobile transcript suite passes 20 tests. The shared UI source type check passes.

The settings overlay is positioned in the conversation stage below the naturally sized bot-control region, so a growing pending question cannot be covered by a fixed toolbar offset. A regression exercises the pending-question layout and preserves the conversation stage. Routines guidance now explicitly says scheduling is unavailable, using the same shared copy in Web and Native Mobile.

With explicit owner approval, the integration dependency now removes the three obsolete `mentionPermission.allowed` UI references and preserves the selected permission mode and server authorization. The current settings head passes 36 focused Web/shared/Electron tests across 6 suites, Electron source typechecks, and an Electron production build. The foundation passes 96 broader Electron/Web Agent regressions including direct bot sends, supervised requests, retry identity and background refresh. Fresh post-rebase renderer captures are still pending; earlier captures above remain historical. Physical-device Native Mobile validation remains pending; keep this PR a draft.

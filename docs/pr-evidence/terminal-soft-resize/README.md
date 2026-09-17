# Terminal resize evidence

Synthetic output only. The fixture mounts the actual Web `TerminalPane` and
Electron `TerminalView` with real xterm and production terminal CSS. The mock
transport holds the canonical grid at 120 columns × 36 rows and does not adopt
soft viewport proposals. Screenshots contain no user terminal or session data.

## Surface matrix

Results apply to this PR's terminal viewport sizing and cursor-accessibility scope.
Browser fixtures mount the production terminal components with synthetic transport;
only the Electron row is native Electron process evidence.

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | pass | pass — resize, late output, scaled wheel cells | pass — canonical grid, pan and font restoration | pass — component and Chromium at 0.75 zoom | pass — `web-canvas-short.png` |
| Web Desktop | pass | pass — resize, late output, wheel cells | pass — canonical grid, pan and font restoration | pass — component and Chromium | pass — `web-desktop-short.png` |
| Electron Desktop | pass | pass — resize, late output, wheel cells | pass — canonical grid, pan and font restoration | pass — component, Chromium and native Electron | pass — `electron-desktop-short.png`, `electron-desktop-expanded.png` |
| Web Mobile | pass | pass — shared soft-grid path, shrink/expand and late output | pass — canonical grid and local presentation state | pass — Chromium mobile viewport/touch emulation with `suppressNativeKeyboard` | pass — `web-mobile-short.png` |
| Native Mobile | N/A | N/A | N/A | N/A | N/A |

Native Mobile uses its independent React Native WebView implementation in
[`TerminalSurface.tsx`](../../../apps/mobile/components/TerminalSurface.tsx), with
its own bundled xterm, fit logic, and native message bridge. It imports neither
`TerminalPane` nor the modified shared DOM presentation helper. This PR fixes
Web Desktop, Web Canvas, and Electron Desktop window resizing and does not
change that renderer or its capabilities.
The coordinating scope reviewer approved this architectural N/A. No Native Mobile
execution or device evidence is claimed.

- `web-desktop-short.png`: Web Desktop renderer in Chromium, 300px window.
- `web-canvas-short.png`: Web Canvas renderer in Chromium at 0.75 zoom, 300px window.
- `web-mobile-short.png`: Web Mobile path in Chromium with a 430px mobile
  viewport, touch emulation, and a 300px terminal.
- `electron-desktop-short.png`: Electron Desktop renderer in native Electron
  under Xvfb with a temporary profile, 300px window.
- `electron-desktop-expanded.png`: the same native Electron renderer expanded
  to 850px, restoring the configured font size.

The fixture bypasses app navigation and real transport; it exercises production
terminal components, styles, fonts, layout, input mapping and native Electron
rendering. The separate `shell/e2e/terminal-sizing.spec.ts` retains app launch and
window drag-resize coverage.

Reproduce Chromium with:

```sh
bun run test:e2e tests/e2e/terminal-soft-grid.e2e.test.ts --maxWorkers=1
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the browser is outside Playwright's cache.
For native Electron, run the same test with `MATRIX_GRID_ELECTRON=1` inside
`xvfb-run -a` on Linux. The test removes its temporary profile on completion.

Assertions cover shrink (600 → 300), expand (850), final-row visibility, actual
scroll extents, restored scale, an SGR wheel report at column 6 / row 35, and later output moving the cursor
below an already short viewport. A scaled double-click followed by Copy also
checks that forwarding pointer coordinates preserves xterm's cancellation of
native browser text selection.

## Electron Desktop packaged clipboard follow-up

The packaged clipboard suite exposed a race between xterm's drag-scroll timer
and the edge-selection snapshot. Capturing immediately when the pointer crosses
the edge preserves the original selected rows before either timer advances the
viewport. A focused regression covers both ordinary and mouse-reporting drags
with an intervening xterm scroll before the first capture timer tick.

The pixel-based test also reused a screen rectangle measured before terminal
output changed the presented grid. It now waits for fonts and stable geometry,
measures the screen after output, and avoids ambiguous half-cell boundaries.
All seven clipboard cases retain their copy and input-routing assertions.

`electron-desktop-edge-selection.png` records the packaged Electron Desktop
terminal after a downward edge drag. It uses the actual built main/preload/renderer
under Xvfb, a temporary profile, and synthetic terminal data from the local stub
gateway; it does not claim live VPS transport coverage. The clipboard assertion
requires the complete final output row before capturing the screenshot.
The keyboard-settings warning visible in the stub-backed screenshot is outside
this fixture's gateway contract; keyboard-settings loading is not validated here.

A further exact-head repeat exposed a shared layout oscillation: rounded cell
metrics at 11px and 12px caused output-only passes to alternate the displayed
grid height. The presentation now reuses its settled layout while viewport,
grid, and font metrics are unchanged; genuine resize/font changes still compute
a new layout. A red/green regression reproduces those quantized metrics, checks
repeated output passes, and verifies expansion restores the configured font.

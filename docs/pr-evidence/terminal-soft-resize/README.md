# Terminal resize evidence

Synthetic output only. The fixture mounts the actual Web `TerminalPane` and
Electron `TerminalView` with real xterm and production terminal CSS. The mock
transport holds the canonical grid at 120 columns × 36 rows and does not adopt
soft viewport proposals. Screenshots contain no user terminal or session data.

- `web-desktop-short.png`: Web Desktop renderer in Chromium, 300px window.
- `web-canvas-short.png`: Web Canvas renderer in Chromium at 0.75 zoom, 300px window.
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
scroll extents, restored scale, and an SGR wheel report at column 6 / row 35.

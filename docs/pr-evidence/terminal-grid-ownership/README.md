# Terminal grid and live ownership evidence

These captures use synthetic terminal output only. The fixture mounts the
production Web `TerminalPane` and Electron `TerminalView`, uses the strict
terminal frame schemas, and holds one canonical 120 × 36 grid while exercising
resize, output, input mapping, ownership revocation, and the read-only observer
action. No user terminal, credential, or session data appears in the evidence.

## Surface matrix

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | pass | pass — readable soft grid, deliberate pan, no cursor-follow drift | pass — revocation stays attached as observer | pass — component + Chromium at 0.75 zoom | pass — `web-canvas-observer.png` |
| Web Desktop | pass | pass — readable soft grid, input gate, explicit takeover | pass — quiet first reconnect, warning after failed retry, observer reconnect | pass — component + Chromium | pass — `web-desktop-observer.png` |
| Electron Desktop | pass | pass — readable grid, input gate, explicit takeover | pass — observer reconnect cannot steal ownership | pass — component + native Electron | pass — `electron-desktop-observer.png` |
| Web Mobile | pass | pass — readable canonical grid and on-screen takeover | pass — observer remains attached and read-only | pass — component + Chromium mobile/touch emulation | pass — `web-mobile-observer.png` |
| Native Mobile | pass | pass — input/resize gate and explicit takeover | pass — foreground/background observer reconnect | pass — focused Jest terminal suites | pending — this Linux agent has no Android/iOS device or emulator; a physical-device capture is still required |

The Native Mobile entry is not an architectural N/A: this PR changes its
ownership behavior. Automated coverage is included, but the repository's
release-equivalent Native Mobile evidence gate requires an Expo development
client or device that is not available in this environment.

## Evidence

- `web-desktop-observer.png`: Chromium Web Desktop at the restored desktop
  window size, with the observer banner and **Continue here** action visible.
- `web-canvas-observer.png`: Chromium Web Canvas at 0.75 zoom, proving the
  ownership affordance remains readable under the Canvas transform.
- `web-mobile-observer.png`: Chromium Web Mobile at a 430px viewport with a
  360px terminal; the complete observer action stays inside the viewport.
- `electron-desktop-observer.png`: native Electron under Xvfb with an isolated
  temporary profile; the observer banner and action render below the terminal.

The fixture also asserts that the takeover action's bounding box remains
inside each captured viewport. Focused unit/component tests assert the 10px
effective glyph floor, stable user-controlled horizontal panning, input denial
while observing, observer-safe reconnect, and takeover behavior.

## Large-file extraction plan

`TerminalPane.tsx` remains above 1,000 lines. This PR keeps the ownership and
reconnect change in its existing connection lifecycle so the writer/observer
gate is atomic with socket replacement, heartbeat shutdown, replay cursors,
and cached-terminal restoration. A follow-up extraction will move that
lifecycle into a focused `useTerminalLiveConnection` controller with these
boundaries:

1. WebSocket creation, generation guards, heartbeat, and reconnect timers.
2. Writer/observer lease intent, revocation, takeover, and input authorization.
3. Connection notices and the serializable state exposed to `TerminalPane`.
4. Focused controller tests for stale generations, timer cleanup, replay resume,
   observer reconnect, and takeover races.

`TerminalPane` will retain xterm construction, grid presentation, clipboard,
and composition only. The extraction is intentionally separate from this fix
so moving the connection lifecycle cannot obscure the reviewed behavior change.

## Reproduction

```sh
pnpm exec vitest run tests/shell/terminal-soft-grid.test.ts \
  tests/ui/terminal-soft-grid.test.ts \
  tests/shell/terminal-pane-scrolling.test.tsx

pnpm exec vitest run --config vitest.e2e.config.ts \
  tests/e2e/terminal-soft-grid.e2e.test.ts --maxWorkers=1

MATRIX_GRID_ELECTRON=1 xvfb-run -a pnpm exec vitest run \
  --config vitest.e2e.config.ts \
  tests/e2e/terminal-soft-grid.e2e.test.ts --maxWorkers=1
```

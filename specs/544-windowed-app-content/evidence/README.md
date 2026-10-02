# Electron Desktop native window evidence

Captured on 2026-10-02 against source head
`1ca816da7eba3e37cdc4a22b226c122bcf88cbb5`, using the actual built Electron
main, preload, renderer and installed-app `WebContentsView`. The isolated
gateway serves a fictional **Color Lab** app; its 4px gold border belongs to
the fixture, not Matrix window chrome. No customer runtime, owner app or
existing credential profile is used. The synthetic profile, gateway and
Electron process are closed after the test.

| State | Native content and host bounds (CSS px) | Matrix frame (CSS px) | Native PNG (device px) |
| --- | --- | --- | --- |
| Before | `(232, 204, 868, 465)` | `(231, 155, 870, 515)` | `1736 × 930` |
| After southeast drag | `(232, 204, 648, 285)` | `(231, 155, 650, 335)` | `1296 × 570` |

The probe performs a real mouse drag on `[data-window-resize="se"]` by
`(-220, -180)` CSS pixels. Before and after the drag, the native view's
`getBounds()` exactly matches the rendered content host's rectangle. The
1px frame border and titlebar account for the outer frame difference; the
native content has no additional left, right or bottom gutter.

- Native app pixels: [before](before-native-app.png), [after](after-native-app.png).
- Renderer chrome and southeast grip: [before](before-renderer-chrome.png), [after](after-renderer-chrome.png).
- Exact measurements: [before](before.json), [after](after.json).
- Provenance: [source head](candidate-head.txt), [built entrypoint SHA-256 digests](candidate-build.sha256).

These are **four separate, unmodified captures**. Native images come from
the attached child view's `webContents.capturePage()`; renderer screenshots
come from Playwright and exclude native child pixels. They are not a
composited window screenshot. The native capture shows app-rendered pixels,
not the window compositor's rounded clipping. The renderer capture shows
the titlebar/frame geometry. These files establish content coverage and
actual resize behavior; they do not independently establish the appearance
of compositor clipping at the titlebar seam. The PR also records the
separate native visual inspection and Electron's uniform-radius limitation.

## Reproduce

Use a manual worktree with its pinned dependencies installed. Build the
candidate, then copy [probe.ts](probe.ts) to the fresh scratch path below
(do not overwrite an existing file). The copy is necessary because the
normal E2E configuration discovers tests under `tests/e2e/`.

```sh
(
set -eu
bun run build:desktop
evidence_probe=tests/e2e/desktop/native-window-evidence-pr2113.e2e.test.ts
if test -e "$evidence_probe" || test -L "$evidence_probe"; then exit 1; fi
cp specs/544-windowed-app-content/evidence/probe.ts "$evidence_probe"
trap 'evidence_status=$?; rm -f "$evidence_probe"; exit "$evidence_status"' 0
MATRIX_DESKTOP_E2E_REQUIRED=1 bun run test:e2e -- "$evidence_probe" --maxWorkers=1
)
```

On Linux, run the test command under `xvfb-run --auto-servernum`. The probe
uses a temporary `OPERATOR_USER_DATA_DIR`, a loopback synthetic gateway,
and synthetic device-token polling through IPC; it does not open the
external authentication browser. New evidence is written under
`output/playwright/native-window-edge-evidence/`, or the explicit
`MATRIX_NATIVE_EVIDENCE_DIR` supplied for a scratch output directory.
Review and remove scratch output after use. The retained run passed **1/1**
native tests after rebasing onto the merged native app-launch change; focused production tests are recorded in the PR.
The recipe propagates test failures after scratch cleanup. The probe registers
acquired resources immediately and attempts every cleanup, including when
startup or a prior close fails; cleanup errors remain test failures.

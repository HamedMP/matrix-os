# Visible launch-bar clearance

Captured September 16, 2026 at a 900 × 600 CSS-pixel viewport.

These are **synthetic app interiors inside actual production window and launch-bar
components**. They contain no customer session content. Web Desktop ran in Chromium;
Electron Desktop ran in a separate Electron process under Xvfb with a temporary
profile. No production runtime or user session was modified.

| State | Window bottom | Launch-bar top | Clearance | Evidence |
| --- | ---: | ---: | ---: | --- |
| Web Desktop maximized | 514 | 522 | 8px | [Screenshot](web-maximized.png) |
| Web Desktop restored oversized bounds | 514 | 522 | 8px | [Screenshot](web-restored.png) |
| Web Desktop resized past the launch bar | 514 | 522 | 8px | [Screenshot](web-resized.png) |
| Electron Desktop floating | 514 | 522 | 8px | [Screenshot](electron-floating.png) |

The Web Desktop fixture mounts `DesktopWindow`, `WebDesktopSurface`, and the real
window-manager store. The Electron fixture mounts `DesktopSurfaceFrame`,
`DesktopTaskbar`, and the real `desktopSurfaceBounds` constraint. Only app interiors
and unrelated app providers are replaced with synthetic content. Styles are built
from the shell's Tailwind stylesheet with Electron component sources included.

Both restore fixtures start from `{x:200,y:160,width:1040,height:680}`. Existing
intentional side/top overflow remains visible in the restored screenshots; this
change reserves the bottom boundary without changing those policies. The bottom
marker remains above the launch bar. The Web Desktop south resize was exercised
with pointer input: shrinking moved the bottom to 404px, then dragging toward
595px stopped the window at 514px.

The automated regressions cover fresh launch, persisted open/closed layouts,
anchored resizing, viewport shrink, tiny viewports, and Canvas-coordinate
preservation. The native-shell suite verifies that maximizing Terminal still hides
the Electron launch bar, and that presentation switches retain app identity.

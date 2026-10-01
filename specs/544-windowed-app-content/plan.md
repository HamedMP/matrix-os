# Windowed app content

The owner reported a white/dark gutter around Stillday in Electron Desktop. Native embeds reserved 16px on the left, right and bottom solely to keep renderer resize handles accessible. Electron native views paint above DOM, so removing padding requires moving the handles outside the native rectangle.

## Outcome and scope

Windowed native apps and Browser fill the existing frame below its titlebar. All eight resize directions remain usable, including Canvas zoom, pointer capture, interruption cleanup and inactive-window focus. The outer frame permits outside hit regions; an inner inherited-radius clip preserves renderer corners. Native geometry includes an optional bounded radius, applied using Electron 41 View.setBorderRadius. This API rounds all native-pane corners; actual Electron visual checks must confirm the titlebar seam and bottom corners. Tabbed panes reset rounding to zero. Web Desktop and Web Canvas retain their existing zero-gutter content and default inside resize controls.

## Validation

Test-first regressions cover native content padding, unclipped outside targets, all eight directions at two zoom levels, real EmbedHost initial/update radius, native clipping reset and zoom conversion. Boundary checks reject invalid/unbounded geometry. Run focused Desktop/UI/IPC tests and Desktop renderer/main typechecks, then inspect the actual Electron app without altering installed apps or owner data. Public docs in the separate site repository describe window content and resizing alongside existing app guidance.

## Invariants

Existing trusted IPC sender/authentication and strict schemas remain authoritative. No app data or manifest changes; no DB writes. Geometry remains renderer-owned, bounded and validated before native use. Overlay suspension, retained snapshots and native view lifecycle remain unchanged. No deployment or merge is authorized by this fix.

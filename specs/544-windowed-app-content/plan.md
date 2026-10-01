# Windowed app content

The owner reported a white/dark gutter around Stillday in Electron Desktop. Native embeds reserved 16px on the left, right and bottom solely to keep renderer resize handles accessible. Electron native views paint above DOM, so removing padding requires moving the handles outside the native rectangle.

## Outcome and scope

Windowed native apps and Browser fill the existing frame below its titlebar. All eight resize directions remain usable, including Canvas zoom, pointer capture, interruption cleanup and inactive-window focus. The outer frame permits outside hit regions; an inner inherited-radius clip preserves renderer corners. Native geometry includes an optional bounded radius, applied using Electron 41 View.setBorderRadius. This API rounds all native-pane corners; actual Electron visual checks must confirm the titlebar seam and bottom corners. Tabbed panes reset rounding to zero. Web Desktop and Web Canvas retain their existing zero-gutter content and default inside resize controls.

## Validation

Test-first regressions cover native content padding, unclipped outside targets, all eight directions at two zoom levels, real EmbedHost initial/update radius, native clipping reset and zoom conversion. Boundary checks reject invalid/unbounded geometry. Run focused Desktop/UI/IPC tests and Desktop renderer/main typechecks, then inspect the actual Electron app without altering installed apps or owner data. Public docs in the separate site repository describe window content and resizing alongside existing app guidance.

## Invariants

The existing desktop preload boundary, embed authentication/session isolation and strict IPC schemas remain authoritative. No app data or manifest changes; no DB writes. Geometry remains renderer-owned, bounded and validated before native use. Overlay suspension, retained snapshots and native view lifecycle remain unchanged. No deployment or merge is authorized by this fix.

## Security architecture

The desktop renderer preload exposes the existing `embed:open` and `embed:set-bounds` operations. Embed launch authentication and isolated sessions remain owned by the existing embed service; geometry updates are validated by the shared IPC contract. The generic IPC registration does not add an exact sender guard in this change; broader generic sender enforcement is outside this geometry fix. This change adds no endpoint or permission. The strict shared bounds schema accepts finite bounded coordinates/dimensions and an optional integer `cornerRadius` from 0 through 64; malformed requests follow the existing safe IPC error policy. Main-process zoom conversion clamps radius again before native use. No user-controlled URLs, file paths, external fetches, credentials, or database access are introduced.

## Integration wiring

`NativeDesktopShell` supplies the available floating-window viewport to `DesktopSurfaceFrame`. Native Electron Desktop windows reserve 16px outside the frame for edge/corner targets, including restored bounds and viewport changes. Drag and resize constraints share the same placement helper and retain the stationary resize edge. Renderer-only windows keep their existing placement policy. Canvas keeps freely pannable positions; offscreen controls are recovered by panning, and scaled targets remain outside native content.

`EmbedHost` measures the content host's actual rectangle and inherited frame radius on initial open and layout updates. The shared IPC schema validates geometry; the embed manager forwards it to the native-view factory, which applies device/page zoom conversion and resets rounding for tabbed content. The app content itself has no extra padding. Pointer capture, focus, blur/cancel/lost-capture cleanup and the rounded renderer-content clip remain active.

## Failure modes and visual limits

Non-finite or oversized radius inputs fail validation; absent radius is zero. An unavailable/unmounted embed uses the existing recovery/snapshot behavior. Tiny viewports fit dimensions to the available region instead of letting minimum sizes hide controls. Electron 41's `View.setBorderRadius(number)` rounds all four corners; it provides no per-corner option. A native pane begins below the titlebar, so the uniform radius may expose a small top-seam cutout. Verify that seam and bottom corners in the actual Electron candidate before claiming visual completion; automated geometry checks do not establish appearance.

## Resource management

This change creates no map, database pool, subscription registry, temporary file, fetch, timer, or new native view. Existing `EmbedHost` layout/resize observers and native-view lifecycle own cleanup on unmount, close and authentication/runtime changes. Window resize listeners and pointer capture release on completion, cancellation, blur, lost capture and unmount. Existing native embed limits and suspension/retained-snapshot policy remain authoritative. No owner app data or installed runtime is changed by validation.

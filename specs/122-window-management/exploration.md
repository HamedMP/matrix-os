# Window resizing and keyboard management

Status: resize implementation; keyboard management proposal for a follow-up PR.

Validation: 168 passing tests in 14 focused Vitest regression suites plus browser drag/hit-target checks using a local shared-controls fixture with embedded iframe content. Web TypeScript check passes. Electron TypeScript is blocked by the existing `DesktopSupportWidget.tsx` PostHog `shutdown` type error; a packaged Electron session and live Terminal PTY were not exercised in this task. Targeted lint passes for the web resize adapter, DesktopWindow, window store and built-in helpers; CanvasWindow retains its pre-existing synchronous-effect lint failure.

## Findings

- Web Desktop and Web Canvas each rendered a single southeast handle. Electron Desktop did the same; its handle was passed as OSWindow content, placing it inside the main pane instead of above the whole window (including sidebars and title bars).
- Web Terminal's 1040 × 680 launch dimensions doubled as hard resize minimums. Its saved layout normalizer also enlarged smaller saved windows. Terminal already collapses its sidebar below 500px; smaller windows are supported by its renderer.
- Web commands (`shell/src/stores/commands.ts`) already drive Cmd K and `useGlobalShortcuts`. Desktop registers new/close/minimize/full-screen commands; its fullscreen command label is currently static.
- Electron uses a separate palette and shortcut dispatcher. `desktop-surfaces.ts` stores window bounds, focus, minimize and maximize-to-tab state. Ctrl+Tab cycles tabs, while Cmd+T opens a new top-level instance for supported apps. Web's openWindow ordinarily focuses the existing path; multiple independent instances require explicit identity, particularly for Terminal persistence.

## Resize delivery

Shared `@matrix-os/ui` controls own eight hit targets, directional cursors, pointer capture, zoom conversion, opposite-edge anchoring, minimum size, and cancellation on pointer cancel, lost capture, blur and unmount. Web adapters update position and dimensions in one store notification. Electron renders controls in an OSWindow frame slot above content/inert panes and reserves space around native embeds. Web Terminal retains a roomy initial size with a 440 × 300 resize minimum, matching Electron's general minimum; reopening preserves smaller saved sizes.

Web Mobile and Native Mobile retain full-screen app navigation: floating-window edge resizing does not apply. Web Canvas keeps its existing fullscreen and zoom-preview guards; Electron tab-maximized windows have no resize handles.

## Desktop click buffer and border placement

Electron Desktop ignores background clicks within 12 CSS pixels of visible floating windows. Explicit Show Desktop controls remain immediate; hidden/minimized windows and Canvas background gestures do not participate in the buffer. The guard measures current DOM rectangles so it accounts for header offsets and actual frame placement.

Web Desktop and Electron Desktop share placement constraints: windows may touch the work-area border, cross left/right/bottom borders by up to 32px, and cross the top by 16px while leaving 32px of a 48px title bar reachable. Resize clamping preserves the opposite edge. Saved Web Desktop placement no longer gains a mandatory 20px inset or automatic centering; Electron no longer clamps every move/resize to a 12px inset. Initial placement may still be centered. Both Canvas presentations retain unconstrained spatial coordinates.

## Recommended keyboard and Cmd K design

Use one shared action catalog and pure geometry planner, consumed by both shortcut dispatchers and palettes. Adapters supply focused window, visible work area, existing bounds and atomic apply/restore operations. Do not duplicate layout calculations or keyboard labels in each renderer.

| Action | Suggested binding (configurable) | Palette label |
| --- | --- | --- |
| Snap to a half | Ctrl+Alt+Arrow | Move window to left/right/top/bottom half |
| Fill available work area | Ctrl+Alt+Enter | Maximize window |
| Restore previous floating bounds | Ctrl+Alt+Backspace | Restore window size |
| Center without resizing | Ctrl+Alt+C | Center window |
| Next/previous visible window | Preserve current Ctrl+Tab behavior until tab/window semantics are reconciled | Focus next/previous window |
| Quarters and thirds | Palette initially | Move window to top-left quarter; left third; center third; right third |
| Arrange several windows | Palette initially | Tile visible windows; cascade visible windows |
| Another app instance | Preserve supported Cmd+T behavior | New Terminal window; new Files window; new Chat window |

Bindings above are proposed, not shipped. Do not intercept Cmd+Arrow editing, terminal Ctrl commands, OS Alt+Tab, browser Cmd+N/T/W, or system full-screen keys indiscriminately. Ctrl+Alt conflicts with some OS/accessibility tools; allow remapping and disabling shortcuts, and always provide Cmd K equivalents. Electron native embedded views need focused-view/main-process routing; web cross-origin iframe key events do not bubble to the parent. Do not promise universal shortcuts until both paths have integration coverage.

Palette UX: introduce a Windows group, searchable by `snap`, `tile`, `half`, `quarter`, `maximize`, `restore`, and app title. Show the target window title. Capture the focused window when opening Cmd K so palette focus does not change the target. Disable commands with a clear reason when no suitable window exists. List open/minimized windows for direct focus/restore. A command's enabled state, label, shortcut, and execution come from the same catalog.

## Geometry and state semantics

- Maximize fills the Matrix work area; native application full screen is a separate action. Electron currently maximizes windows into tabs: the adapter must explicitly handle return-to-floating bounds and focus.
- Web Canvas snaps relative to its visible viewport converted into canvas coordinates, preserving pan/zoom and offscreen windows. Web Desktop and Electron Desktop subtract title bar, taskbar/dock and margins.
- Keep one previous floating rectangle per live window for restore, and one bounded last-arrangement snapshot for undo. Remove records on window close; cap by the live-window limit. Persist normal geometry through existing owner-scoped OS-view state, not a new database or renderer-specific preference store.
- Tiling must respect per-app minimums. When selected windows cannot fit, disable the arrangement or explain the limitation; do not silently overlap them or shrink below usable bounds. Offer cascade as an alternative.
- Multiwindow app identity must remain separate from app path, terminal session and terminal layout identity. New window must create an independent presentation without duplicating or terminating sessions. Closing/minimizing and switching presentations must preserve existing session lifecycle guarantees.
- No new endpoints or permissions are needed for local arrangement. Existing authenticated OS-view persistence remains the authorization source of truth. Rendering and geometry stay shared; adapters supply only surface state and coordinate conversion.

## Delivery sequence and evidence

1. Resize controls with geometry, pointer lifecycle, frame placement, terminal size/restore, and Canvas scale tests. Browser drag checks over embedded content; verify Web Canvas, Web Desktop, then Electron Desktop before release.
2. Shared action catalog, halves, center, maximize/restore and Cmd K Windows group in one parity PR. Extract command registration out of the oversized Desktop composition file before adding behavior.
3. Visible-window switching, quarters/thirds, arrange/cascade, and undo. Test small viewports, sidebar/dock positions, minimized/closed windows, focus after palette dismissal, and refresh persistence.
4. Independent app-window creation and optional named layouts after lifecycle/identity tests. Physical monitor movement is a separate Electron capability; browser windows only control their own viewport.
5. Each delivery includes a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/`. The resize guide accompanies this implementation; keyboard bindings are documented only when shipped.

Reference: [Rectangle](https://rectangleapp.com/) supplies snapping/shortcut interaction precedents; [Rectangle Pro keyboard guide](https://rectangleapp.com/pro/docs/keyboard-shortcuts/) describes multiwindow tile/cascade actions. Matrix manages windows inside its own OS view, so this proposal uses those interactions without native macOS Accessibility permissions or global window control.

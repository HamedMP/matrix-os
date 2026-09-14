# Window resizing and window-management proposal

Status: resize implementation complete; window-management design proposed for a separate implementation PR. No new keyboard bindings are installed by the resize changes.

Validation: 169 tests pass across 14 focused Vitest suites, including the new failing-then-passing accessible-separator regression test. Web TypeScript passed for the initial implementation. The Electron Desktop production renderer build succeeds and was launched locally against the repository's stub gateway. The existing `DesktopSupportWidget.tsx` PostHog `shutdown` type error still prevents a clean Electron TypeScript check. No real VPS PTY or signed installer was tested. [Current running-app evidence and limitations](evidence/README.md).

## Surface coverage for the resize implementation

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | Shared eight-direction controls | Zoom conversion and anchored resizing | Existing layout persistence; no spatial clamping | `window-resize`, `canvas-window-terminal-overlay`, `canvas-interaction-safety` | [Captured at 80% zoom](evidence/web-canvas.jpg); right-edge drag verified in the running Web Canvas |
| Web Desktop | Shared eight-direction controls | Anchored resizing, 32px side/bottom overflow and 16px top overflow | Smaller Terminal restore and partly offscreen saved bounds | `desktop-window-controls`, `window-manager`, `builtin-apps`, `web-desktop-surface`, `window-placement` | [Captured after northwest resize](evidence/web-desktop.jpg) in the running Web Desktop |
| Electron Desktop | Shared controls above frame/native embeds | Eight directions, border overlap, 12px background-click buffer | Existing surface-store and native OS-view persistence | `os-window`, `tab-content`, `desktop-surfaces-store`, `desktop-workspace-plane`, `native-os-view-persistence` | [Captured in the built Electron app](evidence/electron-desktop.jpg); left/corner resize and near/far background clicks verified |
| Web Mobile | N/A — full-screen app navigation | N/A — no floating-window resize interaction | N/A — no changed mobile state path | N/A — resize overlay remains hidden below the Web Desktop breakpoint | N/A — no changed floating-window state to capture |
| Native Mobile | N/A — full-screen app navigation | N/A — no floating-window resize interaction | N/A — no changed native mobile state path | N/A — shared DOM resize controls are not mounted by the native renderer | N/A — no changed floating-window state to capture |

Mobile N/A rationale: this change is limited to floating app windows; Web Mobile and Native Mobile navigate full-screen app views. Introducing floating frames there would be a separate product change. Reviewer approval of these N/A entries is requested with this PR; no mobile screenshot is claimed as evidence. Running-app evidence is attached above; backend connectivity limitations are disclosed with the captures.

## Findings

- Web Desktop and Web Canvas each rendered a single southeast handle. Electron Desktop did the same; its handle was passed as OSWindow content, placing it inside the main pane instead of above the whole window (including sidebars and title bars).
- Terminal’s 1040 × 680 launch dimensions doubled as hard resize minimums in Web Desktop and Web Canvas. Its saved layout normalizer also enlarged smaller saved windows. Terminal already collapses its sidebar below 500px; smaller windows are supported by its renderer.
- Web Desktop and Web Canvas commands (`shell/src/stores/commands.ts`) already drive Cmd K and `useGlobalShortcuts`. Web Desktop registers new/close/minimize/full-screen commands; its fullscreen command label is currently static.
- Electron Desktop uses a separate palette and shortcut dispatcher. `desktop-surfaces.ts` stores window bounds, focus, minimize and maximize-to-tab state. Ctrl+Tab cycles tabs, while Cmd+T opens a new top-level instance for supported apps. The shared Web Desktop/Web Canvas `openWindow` ordinarily focuses the existing path; multiple independent instances require explicit identity, particularly for Terminal persistence.

## Resize delivery

Shared `@matrix-os/ui` controls own eight hit targets, directional cursors, pointer capture, zoom conversion, opposite-edge anchoring, minimum size, and cancellation on pointer cancel, lost capture, blur and unmount. Web Desktop and Web Canvas adapters update position and dimensions in one store notification. Electron Desktop renders controls in an OSWindow frame slot above content/inert panes and reserves space around native embeds. Terminal in Web Desktop and Web Canvas retains a roomy initial size with a 440 × 300 resize minimum, matching Electron Desktop's general minimum; reopening preserves smaller saved sizes.

Web Mobile and Native Mobile retain full-screen app navigation: floating-window edge resizing does not apply. Web Canvas keeps its existing fullscreen and zoom-preview guards; Electron Desktop tab-maximized windows have no resize handles.

## Background click buffer and border placement

Electron Desktop ignores background clicks within 12 CSS pixels of visible floating windows. Explicit Show Desktop controls remain immediate; hidden/minimized windows, Web Canvas gestures, and Electron Desktop Canvas gestures do not participate in the buffer. The guard measures current DOM rectangles so it accounts for header offsets and actual frame placement.

Web Desktop and Electron Desktop share placement constraints: windows may touch the work-area border, cross left/right/bottom borders by up to 32px, and cross the top by 16px while leaving 32px of a 48px title bar reachable. Resize clamping preserves the opposite edge. Saved Web Desktop placement no longer gains a mandatory 20px inset or automatic centering; Electron Desktop no longer clamps every move/resize to a 12px inset. Initial placement may still be centered. Web Canvas and Electron Desktop in Canvas mode retain unconstrained spatial coordinates.

## Recommended keyboard and Cmd K design

Use one shared action catalog and pure geometry planner, consumed by both shortcut dispatchers and palettes. Adapters supply focused window, visible work area, existing bounds and atomic apply/restore operations. Do not duplicate layout calculations or keyboard labels in each renderer.

| Action | Suggested binding (configurable) | Palette label |
| --- | --- | --- |
| Snap to a half | Ctrl+Alt+Shift+Arrow | Move window to left/right/top/bottom half |
| Fill available work area | Ctrl+Alt+Shift+Enter | Maximize window |
| Restore previous floating bounds | Ctrl+Alt+Shift+Backspace | Restore window size |
| Center without resizing | Ctrl+Alt+Shift+C | Center window |
| Next/previous visible window | Preserve current Ctrl+Tab behavior until tab/window semantics are reconciled | Focus next/previous window |
| Quarters and thirds | Palette initially | Move window to top-left quarter; left third; center third; right third |
| Arrange several windows | Palette initially | Tile visible windows; cascade visible windows |
| Another app instance | Preserve supported Cmd+T behavior | New Terminal window; new Files window; new Chat window |

Bindings above are proposed, not shipped. Do not intercept Cmd+Arrow editing, terminal Ctrl commands, OS Alt+Tab, browser Cmd+N/T/W, or system full-screen keys indiscriminately. Enable the Matrix profile explicitly; keep Cmd K equivalents available when shortcuts are off. Even Ctrl+Alt+Shift can conflict with a customized OS/accessibility tool; profiles cannot guarantee exclusive ownership of a key combination. Electron Desktop native embedded views need focused-view/main-process routing; web cross-origin iframe key events do not bubble to the parent. Do not promise universal shortcuts until both paths have integration coverage.

Palette UX: introduce a Windows group, searchable by `snap`, `tile`, `half`, `quarter`, `maximize`, `restore`, and app title. Show the target window title. Capture the focused window when opening Cmd K so palette focus does not change the target. Disable commands with a clear reason when no suitable window exists. List open/minimized windows for direct focus/restore. A command's enabled state, label, shortcut, and execution come from the same catalog.

## Geometry and state semantics

- Maximize fills the Matrix work area; native application full screen is a separate action. Electron Desktop currently maximizes windows into tabs: the adapter must explicitly handle return-to-floating bounds and focus.
- Web Canvas snaps relative to its visible viewport converted into canvas coordinates, preserving pan/zoom and offscreen windows. Web Desktop and Electron Desktop subtract reserved title bar and taskbar/dock space; snapping adds no mandatory outer gutter.
- Keep one previous floating rectangle per live window for restore, and one bounded last-arrangement snapshot for undo. Remove records on window close; cap by the live-window limit. Persist normal geometry through existing owner-scoped OS-view state, not a new database or renderer-specific preference store.
- Tiling must respect per-app minimums. When selected windows cannot fit, disable the arrangement or explain the limitation; do not silently overlap them or shrink below usable bounds. Offer cascade as an alternative.
- Multiwindow app identity must remain separate from app path, terminal session and terminal layout identity. New window must create an independent presentation without duplicating or terminating sessions. Closing/minimizing and switching presentations must preserve existing session lifecycle guarantees.
- No new endpoints or permissions are needed for local arrangement. Existing authenticated OS-view persistence remains the authorization source of truth. Rendering and geometry stay shared; adapters supply only surface state and coordinate conversion.

## Delivery sequence and evidence

1. Resize controls with geometry, pointer lifecycle, frame placement, terminal size/restore, and Web Canvas scale tests. Browser drag checks over embedded content; verify Web Canvas, Web Desktop, then Electron Desktop before release.
2. Shared action catalog, halves, center, maximize/restore and Cmd K Windows group in one parity PR. Extract command registration out of the oversized Desktop composition file before adding behavior.
3. Visible-window switching, quarters/thirds, arrange/cascade, and undo. Test small viewports, sidebar/dock positions, minimized/closed windows, focus after palette dismissal, and refresh persistence.
4. Independent app-window creation and optional named layouts after lifecycle/identity tests. Physical monitor movement is a separate Electron Desktop capability; browser windows only control their own viewport.
5. Each delivery includes a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/`. The resize guide accompanies this implementation; keyboard bindings are documented only when shipped.

Reference: [Rectangle](https://rectangleapp.com/) supplies snapping/shortcut interaction precedents; [Rectangle Pro keyboard guide](https://rectangleapp.com/pro/docs/keyboard-shortcuts/) describes multiwindow tile/cascade actions. Matrix manages windows inside its own OS view, so this proposal uses those interactions without native macOS Accessibility permissions or global window control.


## Rectangle and other native window managers

Matrix changes the geometry of app surfaces inside its own renderer. Rectangle and similar macOS utilities change the outer Matrix OS application window. Resizing with the mouse introduces no keyboard conflict, and this PR registers no new shortcuts or global accelerators.

Keyboard ownership is the possible conflict: a native manager can consume its global shortcut before Matrix receives it. Matrix must not assume it can prevent that by calling `preventDefault`, and must not register OS-global shortcuts for internal layout actions. Native routing must be scoped to the focused Matrix window and its focused embedded view. It must stop handling these bindings when the setting is off, Matrix loses focus, a modal is open, or an IME composition is active.

Rectangle's maintainer documents the exception flow: focus Matrix OS, open Rectangle's menu-bar menu, then select **Ignore Matrix OS**. Bring Matrix forward and deselect the same item to reverse it. Rectangle unregisters its shortcuts while an ignored app is frontmost. For Web Desktop, ignoring Chrome/Safari/etc. applies to that browser application, not just the Matrix website. Prefer Cmd K or a separate Matrix binding profile if Rectangle should keep managing other browser windows. Other utilities have their own application-exclusion settings; Matrix cannot provide a universal exception switch for them.

Matrix must never edit another window manager's preferences automatically. An inline help link can explain the exclusion flow; there is no need for Accessibility permission, process discovery, or a new backend service.

Sources: [Rectangle maintainer's ignore-app instructions](https://github.com/rxhanson/Rectangle/issues/47), [Rectangle's shortcut-conflict troubleshooting](https://github.com/rxhanson/Rectangle#troubleshooting).

## Shortcut preference and discoverability

Add **Settings → Appearance → Window management → Window shortcuts** in Web Canvas, Web Desktop and Electron Desktop, using one shared preference model and copy. The control offers three profiles:

| Profile | Behavior |
| --- | --- |
| Off — Cmd K only (initial default) | No dedicated window-management key listeners; mouse resizing, existing Web Canvas, Web Desktop and Electron Desktop shortcuts and all Windows palette actions continue working. |
| Matrix | Ctrl+Alt+Shift bindings listed above. This avoids Rectangle's usual Ctrl+Alt family without claiming conflict detection. |
| Rectangle-style | Ctrl+Alt versions of the same bindings, for people who have excluded Matrix in their native manager or deliberately remapped it. |

Cmd K includes **Enable Matrix window shortcuts**, **Use Rectangle-style window shortcuts**, and **Disable window shortcuts**. Show the current profile next to the settings action. Changing a profile updates labels and routing immediately, including focused native embeds. Persist it through the existing owner-scoped OS-view settings with distinct Web Desktop/Web Canvas and Electron Desktop preferences; missing or invalid values normalize to Off. Never install bindings before hydration, and preserve the user's current choice if a delayed settings load completes after an edit. If saving fails, show a generic save error and retain the chosen setting for the current session.

A later custom-key editor can build on the action IDs, with duplicate-binding validation and a reset option. It is not needed to make the first release easy to disable. Do not intercept ordinary Ctrl+C/D/Z inside Terminal, Cmd+Arrow text movement, native Alt+Tab, or browser tab/window controls. Match physical key codes for letters because Option can change `event.key` on macOS. Window actions can run from a text editor only with the exact opted-in modifier set; suppress repeat events for restore/undo and instance creation.

## Implementation contract and acceptance criteria

The first keyboard PR should deliver a cohesive slice: shared catalog and geometry, halves, maximize/restore, center, direct window switching, both palettes, and the three-profile preference. Keep existing native fullscreen and maximize-to-tab controls distinct from **Maximize window**, which fills the Matrix work area while retaining floating-window semantics. Each action has a stable ID, label, search keywords, applicable surfaces, enabled state/reason, and optional shortcut. Adapters own only window lookup, coordinate conversion and store mutation; the planner returns a validated layout without applying partial results.

1. Open Notes and Terminal. Capture Terminal as the target when opening Cmd K. Selecting **Move window to right half** moves Terminal only, even though the search input now has focus. If Terminal closes before selection, fail safely with **This window is no longer open**; do not move a different window.
2. Snap, then maximize, then restore: restore the original floating bounds. Dragging or edge resizing after snapping establishes a new floating baseline. Restore snapshots are scoped to the current presentation and removed on close; presentation switching cannot apply Web Desktop coordinates to Web Canvas or Electron Desktop coordinates to its Canvas presentation.
3. Palette window search includes open/minimized app titles and restores/focuses the chosen instance. Next/previous visible window excludes hidden, minimized, closed and inactive-tab surfaces; when cycling cannot change focus, do not consume its key event. Preserve Ctrl+Tab's existing tab behavior until a separate window-cycle binding is approved.
4. In Web Canvas and Electron Desktop’s Canvas presentation, calculate the visible work area from pan/zoom and snap within that rectangle without changing the camera. Test at 50%, 100% and 200% zoom, including nonzero pan. In Web Desktop and Electron Desktop, snapped edges meet reserved chrome boundaries exactly.
5. Start with shortcuts Off. Press every proposed binding in a terminal and text field: Matrix must not handle any. Enable Matrix and verify exact modifiers, keyboard layout, dialog suppression, focus loss, hydration and immediate disabling. Cmd K actions work in every profile. Test Rectangle enabled, ignored and configured with a conflicting custom shortcut; document that a consumed native shortcut cannot reach Matrix.
6. Test native embedded Terminal/browser input via the existing main-process input bridge, with routing tied to the focused live surface. Cross-origin Web iframe focus cannot be handled by an unrestricted parent listener: retain clickable palette access in shell chrome, and use a narrowly validated existing app bridge where supported. Do not claim keyboard parity inside arbitrary third-party iframes without such a bridge.
7. Arrange-visible-windows follows with quarters/thirds, tile, cascade and one undo snapshot. Plan every target first and apply all bounds atomically. Ignore closed/minimized/hidden windows, enforce minimums, and refuse an arrangement that cannot fit. Undo only live matching instances and never resurrect a closed window. Cap all history to the live-window limit plus one bounded arrangement snapshot.
8. Multiwindow creation follows once canonical path and instance identity are separated in both clients. **New Terminal window** gets a fresh layout identity and preserves the existing Terminal and PTY; **New Files window** may start at the current directory; **New Chat window** opens a new draft. Refresh and mode changes must restore independent instances without duplicating backend sessions. Existing supported Electron Desktop Cmd+T behavior continues unchanged until this parity work is validated.

Each slice requires regression tests for the shared planner, store adapters and actual palette/keyboard wiring, followed by Web Canvas → Web Desktop → Electron Desktop interaction checks and a companion public-docs PR. Web Mobile and Native Mobile keep full-screen navigation and do not expose floating-window geometry controls. Named saved layouts, custom shortcut recording, native monitor movement and automatic edge-drag snapping remain subsequent proposals.

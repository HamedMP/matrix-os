# Tasks: Canvas Desktop Mode

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T1250-T1279

## User Stories

- **US55**: "I can zoom out to see all my apps at once and zoom into one to use it"
- **US56**: "I can group related apps together and label them (Work, Finance, Study)"
- **US57**: "I can pan across my canvas to navigate between groups of apps"
- **US58**: "I see a minimap showing where I am on the canvas"
- **US59**: "Switching between desktop and canvas mode preserves my window positions"
- **US60**: "The canvas stays smooth even with 20+ app windows open"

---

## Phase A: Window Manager Extraction (T1250-T1253)

### Tests (TDD -- write FIRST)

- [ ] T1250a [US59] Write `tests/shell/window-manager.test.ts` (~15 tests):
  - openWindow adds window with unique id, default size 640x480, cascading position
  - closeWindow removes window from state
  - minimizeWindow sets minimized=true
  - restoreWindow sets minimized=false, brings to top z-index
  - moveWindow updates x, y coordinates
  - resizeWindow updates width, height (respects MIN_WIDTH/MIN_HEIGHT)
  - focusWindow sets highest z-index
  - getWindow returns window by id, undefined for unknown id
  - Layout persistence: state change triggers debounced save
  - Multiple windows maintain correct z-order

### T1250 [US59] Window manager Zustand store
- [ ] Create `shell/src/hooks/useWindowManager.ts`
- [ ] Zustand store with `windows: AppWindow[]`, `nextZ: number`
- [ ] Actions: openWindow, closeWindow, minimizeWindow, restoreWindow, moveWindow, resizeWindow, focusWindow, getWindow
- [ ] openWindow: generates `win-{timestamp}-{rand4}` id, cascading position, default 640x480
- [ ] Constants: MIN_WIDTH=320, MIN_HEIGHT=200
- **Output**: Centralized window state management

### T1251 [US59] Layout persistence in store
- [ ] Move debounced PUT /api/layout from Desktop.tsx into useWindowManager
- [ ] Subscribe to state changes, debounce 500ms, serialize windows to LayoutWindow format
- [ ] Track closedPaths for `state: "closed"` entries in layout
- [ ] Load layout on store init (GET /api/layout + GET /files/system/modules.json)
- **Output**: Layout save/load works through the store, not component state

### T1252 [US59] Refactor Desktop.tsx to consume store
- [ ] Replace `useState<AppWindow[]>` with `useWindowManager()` store
- [ ] Replace all local window manipulation (inline setWindows calls) with store actions
- [ ] Remove module-level `nextZ` counter (now in store)
- [ ] Remove layout persistence logic from Desktop.tsx (now in store)
- [ ] Keep all rendering logic in Desktop.tsx for now (extract renderer in Phase C)
- **Output**: Desktop.tsx is thinner, delegates state to store. Zero behavior change.

### T1253 [US59] Verify zero regression
- [ ] Run full test suite (`bun run test`) -- all 993+ tests pass
- [ ] Manual smoke test: open/close/minimize/resize/drag windows
- [ ] Verify layout persistence: refresh page, windows restored
- [ ] Verify dock interactions unchanged
- [ ] Verify MissionControl still launches apps into windows
- **Output**: Confidence that extraction introduced no regressions

---

## Phase B: Canvas Transform (T1255-T1259)

### Tests (TDD -- write FIRST)

- [ ] T1255a [US55] Write `tests/shell/canvas-transform.test.ts` (~18 tests):
  - Initial state: zoom=1, panX=0, panY=0
  - setZoom clamps to ZOOM_MIN (0.1) and ZOOM_MAX (3.0)
  - zoomIn increments by ZOOM_STEP (0.1)
  - zoomOut decrements by ZOOM_STEP (0.1)
  - Focal point zoom: zoom in at (500, 300) keeps that point stable
  - setPan updates panX, panY
  - screenToCanvas converts screen coords to canvas coords at current transform
  - canvasToScreen converts canvas coords to screen coords
  - screenToCanvas is inverse of canvasToScreen (round-trip)
  - fitAll calculates zoom and pan to fit given bounds with padding
  - fitAll with no windows returns default transform

### T1255 [US55] Canvas transform hook
- [ ] Create `shell/src/hooks/useCanvasTransform.ts`
- [ ] Zustand store: zoom, panX, panY
- [ ] Actions: setZoom (with optional focal point), setPan, zoomIn, zoomOut
- [ ] Focal point zoom: adjust pan so point under cursor stays fixed
- [ ] Constants: ZOOM_MIN=0.1, ZOOM_MAX=3.0, ZOOM_STEP=0.1, INTERACTION_THRESHOLD=0.6
- [ ] fitAll: calculate zoom + pan to fit all windows with 50px padding
- [ ] fitGroup: calculate zoom + pan to fit group bounds
- [ ] fitWindow: zoom + pan to center a single window at 100%
- [ ] screenToCanvas / canvasToScreen coordinate conversion
- **Output**: Complete zoom/pan state management with coordinate math

### T1256 [US55] Canvas transform component
- [ ] Create `shell/src/components/canvas/CanvasTransform.tsx`
- [ ] Render: `<div style={{ transform: scale(zoom) translate(panX, panY) }}>` wrapper
- [ ] Wheel event handler: zoom in/out at cursor focal point
- [ ] Pointer event handlers for pan: Space+pointerdown starts pan, pointermove updates, pointerup ends
- [ ] Middle-click drag: alternative pan trigger
- [ ] `transform-origin: 0 0` for predictable transform math
- [ ] Prevent default on handled events (no page scroll during canvas zoom)
- **Output**: Interactive pan/zoom container

### T1257 [US55] Pinch-to-zoom support
- [ ] Touch event handlers in CanvasTransform
- [ ] Two-finger pinch: calculate distance delta, map to zoom change
- [ ] Two-finger drag: pan canvas
- [ ] Focal point: midpoint between two touches
- [ ] Prevent default on touch events (no browser zoom/scroll)
- **Output**: Trackpad and tablet support

### T1258 [US55] Keyboard shortcuts for canvas
- [ ] Register shortcuts in command store:
  - Cmd+0: fitAll
  - Cmd+1: zoom to 100%
  - Cmd++: zoomIn
  - Cmd+-: zoomOut
  - Cmd+G: group selected (Phase D)
- [ ] Shortcuts only active when in canvas mode
- [ ] Add to Command Palette under "Canvas" group
- **Output**: Keyboard-driven canvas navigation

### T1259 [US55] Animated transitions
- [ ] fitAll, fitGroup, fitWindow animate over 300ms with ease-out
- [ ] Use requestAnimationFrame loop or CSS transition on transform
- [ ] Flag `isAnimating` during transition (disable pointer events on canvas)
- [ ] Interrupt animation on user input (wheel/pan during animation cancels it)
- **Output**: Smooth zoom-to-fit transitions

---

## Phase C: Canvas Renderer (T1260-T1265)

### Tests (TDD -- write FIRST)

- [ ] T1260a [US55] Write `tests/shell/canvas-renderer.test.ts` (~10 tests):
  - Renders windows from useWindowManager store
  - Windows positioned at canvas-space coordinates
  - Zoom < INTERACTION_THRESHOLD renders preview mode
  - Zoom >= INTERACTION_THRESHOLD renders interactive mode
  - Preview mode: no iframe, shows title card
  - Interactive mode: full iframe with AppViewer

- [ ] T1261a [US59] Write `tests/gateway/canvas-api.test.ts` (~6 tests):
  - GET /api/canvas returns canvas.json (default if missing)
  - PUT /api/canvas validates and writes canvas.json
  - PUT /api/canvas rejects invalid schema
  - Default canvas.json has zoom=1, panX=0, panY=0, empty groups

### T1260 [US55] Canvas renderer component
- [ ] Create `shell/src/components/canvas/CanvasRenderer.tsx`
- [ ] Consumes `useWindowManager` for windows, `useCanvasTransform` for transform
- [ ] Wraps all windows in `<CanvasTransform>`
- [ ] Renders `<CanvasWindow>` for each window (not the existing Card markup)
- [ ] Renders `<CanvasMinimap>` (Phase E) and `<CanvasToolbar>` (Phase E)
- [ ] Empty state: "No apps open. Open apps from the dock or Mission Control."
- **Output**: Canvas mode renders windows in a zoomable container

### T1261 [US60] Canvas window component
- [ ] Create `shell/src/components/canvas/CanvasWindow.tsx`
- [ ] Props: window (AppWindow), zoom (number), isInteractive (boolean)
- [ ] Interactive mode (zoom >= 0.6): full window chrome (traffic lights, title, resize handle, AppViewer iframe)
- [ ] Preview mode (zoom < 0.6): simplified card with app title, colored header, no iframe
- [ ] Drag behavior: interactive = title bar only; preview = entire window
- [ ] `pointer-events: none` overlay on iframes during drag/resize (existing pattern)
- [ ] Scale-aware hit targets: enlarge click targets when zoomed out
- **Output**: Windows adapt their rendering to zoom level

### T1262 [US59] Mode-based rendering in Desktop.tsx
- [ ] Modify Desktop.tsx: check `useDesktopMode()` for current mode
- [ ] Mode `desktop`/`dev`: render existing desktop layout (extracted from current Desktop.tsx)
- [ ] Mode `canvas`: render `<CanvasRenderer />`
- [ ] Mode `ambient`/`conversational`: existing behavior (no windows)
- [ ] Dock renders in all modes where showDock=true (desktop, dev, canvas)
- **Output**: Canvas mode accessible via mode cycling

### T1263 [US59] Add canvas to desktop-mode.ts
- [ ] Add `"canvas"` to `DesktopMode` type union
- [ ] Add canvas entry to `MODE_CONFIGS` record
- [ ] Canvas config: showDock=true, showWindows=true, showBottomPanel=false, chatPosition="sidebar"
- [ ] Mode cycle includes canvas (desktop -> dev -> canvas -> ambient -> conversational)
- [ ] Command Palette: `mode:canvas` command registered
- **Output**: Canvas mode is a first-class desktop mode

### T1264 [US59] Gateway canvas API endpoints
- [ ] Add `GET /api/canvas` to server.ts: read `~/system/canvas.json`, fallback to default
- [ ] Add `PUT /api/canvas` to server.ts: validate body, write `~/system/canvas.json`
- [ ] Default canvas.json: `{ "transform": { "zoom": 1, "panX": 0, "panY": 0 }, "groups": [] }`
- [ ] Add `home/system/canvas.json` template for first-boot
- **Output**: Canvas state persisted as file

### T1265 [US59] Canvas state persistence
- [ ] Load canvas.json on CanvasRenderer mount (GET /api/canvas)
- [ ] Restore transform (zoom, panX, panY) and groups on load
- [ ] Debounced save on transform change (500ms, PUT /api/canvas)
- [ ] Hot-reload via useFileWatcher when canvas.json changes externally (AI modifies it)
- **Output**: Canvas state survives page refresh and AI modifications

---

## Phase D: Groups (T1268-T1272)

### Tests (TDD -- write FIRST)

- [ ] T1268a [US56] Write `tests/shell/canvas-groups.test.ts` (~14 tests):
  - createGroup returns unique id, stores label + color + windowIds
  - deleteGroup removes group, windows remain
  - renameGroup updates label
  - setGroupColor updates color
  - addToGroup adds windowId to group
  - removeFromGroup removes windowId from group
  - toggleCollapsed flips collapsed state
  - getGroupBounds returns bounding box of member windows + padding
  - getGroupBounds returns null for empty group
  - Group with collapsed=true: bounds shrink to label-only size
  - Window can only belong to one group (adding to new group removes from old)

### T1268 [US56] Canvas groups store
- [ ] Create `shell/src/stores/canvas-groups.ts`
- [ ] Zustand store: groups (CanvasGroup[])
- [ ] Actions: createGroup, deleteGroup, renameGroup, setGroupColor, addToGroup, removeFromGroup, toggleCollapsed
- [ ] getGroupBounds: calculate bounding box from member window positions (reads useWindowManager)
- [ ] Enforce single-group membership: adding to group B removes from group A
- [ ] Persistence: included in canvas.json save/load cycle
- **Output**: Group state management with spatial bounds

### T1269 [US56] Canvas group component
- [ ] Create `shell/src/components/canvas/CanvasGroup.tsx`
- [ ] Renders labeled rectangle behind member windows
- [ ] Auto-sized: bounds from getGroupBounds + 20px padding
- [ ] Header: label text + collapse toggle + color dot
- [ ] Collapsed: shows header only (fixed height), hides member windows
- [ ] Group border uses group color at 30% opacity
- [ ] Group header background uses group color at 15% opacity
- **Output**: Visual group containers on the canvas

### T1270 [US56] Selection rectangle for grouping
- [ ] Create `shell/src/components/canvas/SelectionRect.tsx`
- [ ] Click+drag on empty canvas area: draw selection rectangle
- [ ] On release: select all windows within rectangle bounds
- [ ] Selected windows get visual indicator (blue border glow)
- [ ] Cmd+G on selection: prompt for group name, create group
- [ ] Click on empty area: deselect all
- [ ] Escape: deselect all
- **Output**: Drag-select to create groups

### T1271 [US56] Group interactions
- [ ] Drag group header: move entire group (updates all member window positions)
- [ ] Double-click group header: fitGroup (zoom to fit group bounds)
- [ ] Right-click group header: context menu (rename, change color, ungroup, delete)
- [ ] Drag window out of group bounds: auto-remove from group
- [ ] Drag window into group bounds: auto-add to group (with visual hover indicator)
- **Output**: Intuitive group manipulation

### T1272 [US56] Group persistence
- [ ] Groups saved in canvas.json alongside transform
- [ ] Save on group state change (debounced 500ms)
- [ ] Load groups from canvas.json on mount
- [ ] Handle stale windowIds (window deleted but still in group): filter on load
- **Output**: Groups survive refresh

---

## Phase E: Navigation & Polish (T1275-T1279)

### Tests (TDD -- write FIRST)

- [ ] T1275a [US58] Write `tests/shell/canvas-minimap.test.ts` (~8 tests):
  - calculateMinimapScale returns correct scale for given canvas bounds
  - windowToMinimap converts canvas coords to minimap coords
  - viewportRect calculates correct position and size from transform + screen size
  - Click on minimap sets correct pan values
  - Minimap bounds include all windows + padding

### T1275 [US58] Canvas minimap
- [ ] Create `shell/src/components/canvas/CanvasMinimap.tsx`
- [ ] Fixed 200x140 panel in bottom-right corner, semi-transparent background
- [ ] `<canvas>` element for rendering (performance, not React DOM)
- [ ] Draw: scaled window rectangles (colored by group or default gray)
- [ ] Draw: group outlines (group color, dashed)
- [ ] Draw: viewport indicator (semi-transparent blue rectangle)
- [ ] Click: pan canvas to center clicked point
- [ ] Drag viewport indicator: live pan
- [ ] Re-render on window/group/transform change
- **Output**: Always-visible navigation aid

### T1276 [US55] Canvas toolbar
- [ ] Create `shell/src/components/canvas/CanvasToolbar.tsx`
- [ ] Fixed bar at top-center of canvas area (or bottom-center, configurable)
- [ ] Zoom slider (0.1x to 3.0x) + percentage text display
- [ ] Buttons: zoom in (+), zoom out (-), fit all (frame icon), fit selection
- [ ] Grid snap toggle (optional, for alignment-oriented users)
- [ ] Keyboard shortcut hints in button tooltips
- **Output**: Visual zoom controls

### T1277 [US59] First-time auto-arrange
- [ ] When entering canvas mode for the first time (no canvas.json exists):
  - Auto-arrange all open windows in a grid layout
  - Grid: 3 columns, 20px gap, starting at (50, 50)
  - Set zoom to fitAll
- [ ] Only triggers once (canvas.json created after arrangement)
- [ ] If no windows are open, just set default transform
- **Output**: Canvas mode starts usable, not with all windows at (0,0)

### T1278 Canvas mode AI knowledge file
- [ ] Create `home/agents/knowledge/canvas-mode.md`
- [ ] Document: canvas.json schema, group operations, zoom/pan commands
- [ ] Example prompts: "group my work apps together", "zoom out to see everything", "create a Study area"
- [ ] AI can modify canvas.json directly via write_file to rearrange canvas
- **Output**: AI can assist with canvas organization

### T1279 Canvas mode in dock
- [ ] Add canvas mode icon to dock mode cycle button
- [ ] Tooltip: "Canvas mode -- spatial workspace with zoom and groups"
- [ ] Mode indicator: show current mode name briefly on switch (toast or subtle label)
- **Output**: Discoverable mode switching

---

## Checkpoint

1. Extract window manager (Phase A): `bun run test` passes, zero behavior change, windows work exactly as before
2. Pan + zoom (Phase B): scroll to zoom at cursor, space+drag to pan, Cmd+0 fits all
3. Canvas renderer (Phase C): switch to canvas mode, windows render, zoom out shows previews, zoom in restores iframes
4. Groups (Phase D): drag-select windows, Cmd+G to group, double-click group to zoom-to-fit, drag group moves all members
5. Navigation (Phase E): minimap shows canvas overview, click minimap to navigate, toolbar controls zoom
6. Mode switching: desktop -> canvas -> desktop preserves window positions
7. Persistence: refresh page in canvas mode, transform + groups restored
8. Performance: 20 windows zoomed out at 60fps (no iframes in preview mode)
9. `bun run test` passes (all new + existing tests)

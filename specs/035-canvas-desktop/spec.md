# 035: Canvas Desktop Mode

## Status: Planned

## Problem

The current desktop mode positions app windows with absolute pixel coordinates and free-form dragging. This works for a handful of windows, but breaks down when users have 10+ apps and need spatial organization. There is no way to:

- Zoom out to see all apps at once, then zoom into one to interact
- Group related apps (e.g., "Work", "Finance", "Study") into labeled clusters
- Pan across a large spatial canvas like Miro or Figma
- See a minimap for orientation on a large canvas
- Navigate between app clusters quickly

The existing mode system (`desktop-mode.ts`) supports 4 modes (desktop, ambient, dev, conversational) but none offer a spatial canvas metaphor.

## Solution

Add a new `canvas` desktop mode: an infinite pannable, zoomable canvas where app windows are placed spatially. Users can group apps into labeled clusters, zoom out to navigate between groups, and zoom into a single app for full interaction. Think Miro/Figma for your OS desktop.

Key interactions:

- **Pan**: Space+drag, middle-click drag, or two-finger trackpad
- **Zoom**: Scroll wheel, pinch-to-zoom, or +/- keys
- **Group**: Drag-select apps, name the group, collapse/expand
- **Navigate**: Minimap click, double-click group to zoom-to-fit, Cmd+0 to fit all

The canvas and desktop modes share the same window management state (`AppWindow[]`), but render differently. Canvas adds a transform layer, zoom/pan controls, grouping, and a minimap.

## Task Range: T1250-T1279

## Architecture

```
Desktop.tsx (existing)
  |-- useWindowManager (EXTRACTED: shared state + operations)
  |     |-- windows: AppWindow[]
  |     |-- openWindow, closeWindow, minimizeWindow
  |     |-- moveWindow, resizeWindow, focusWindow
  |     |-- layout persistence (debounced PUT /api/layout)
  |
  |-- DesktopRenderer (existing behavior, extracted)
  |     |-- Free-form absolute positioning
  |     |-- Dock sidebar
  |
  |-- CanvasRenderer (NEW)
        |-- CanvasTransform (pan/zoom container)
        |     |-- CSS transform: scale(zoom) translate(panX, panY)
        |     |-- Pointer events: pan, zoom, selection rectangle
        |
        |-- CanvasWindow (NEW: window chrome for canvas context)
        |     |-- Interactive when zoom > INTERACTION_THRESHOLD (0.6)
        |     |-- Preview thumbnail when zoomed out
        |     |-- Group membership indicator
        |
        |-- CanvasGroup (NEW: visual group container)
        |     |-- Label, color, bounds (auto-calculated from children)
        |     |-- Collapse/expand toggle
        |     |-- Drag to move entire group
        |
        |-- CanvasMinimap (NEW: navigation aid)
        |     |-- Scaled-down viewport indicator
        |     |-- Click to pan, drag to reposition viewport
        |
        |-- CanvasToolbar (NEW: zoom controls + mode tools)
              |-- Zoom slider + percentage
              |-- Fit all / Fit selection
              |-- Grid snap toggle
```

### Mode Integration

```typescript
// shell/src/stores/desktop-mode.ts -- add canvas mode
type DesktopMode = 'desktop' | 'ambient' | 'dev' | 'conversational' | 'canvas';

const MODE_CONFIGS: Record<DesktopMode, ModeConfig> = {
  // ... existing modes ...
  canvas: {
    id: 'canvas',
    label: 'Canvas',
    description: 'Spatial canvas with zoom, pan, and app grouping',
    showDock: true,
    showWindows: true,
    showBottomPanel: false,
    chatPosition: 'sidebar',
  },
};
```

## Design

### Window Manager Extraction

Extract all window state and operations from Desktop.tsx into a shared hook:

```typescript
// shell/src/hooks/useWindowManager.ts
interface WindowManagerState {
  windows: AppWindow[];
  nextZ: number;
}

interface WindowManagerActions {
  openWindow(path: string, title: string, opts?: Partial<AppWindow>): string; // returns id
  closeWindow(id: string): void;
  minimizeWindow(id: string): void;
  restoreWindow(id: string): void;
  moveWindow(id: string, x: number, y: number): void;
  resizeWindow(id: string, width: number, height: number): void;
  focusWindow(id: string): void; // brings to top z-index
  getWindow(id: string): AppWindow | undefined;
}

// Zustand store (replaces useState in Desktop.tsx)
const useWindowManager = create<WindowManagerState & WindowManagerActions>(...)
```

Layout persistence moves into the store (debounced PUT /api/layout on state change).

### Canvas Transform

The canvas is a CSS transform container. All window positions are in "canvas space" -- the transform maps canvas coordinates to screen coordinates.

```typescript
// shell/src/hooks/useCanvasTransform.ts
interface CanvasTransform {
  zoom: number; // 0.1 to 3.0 (1.0 = 100%)
  panX: number; // canvas-space offset
  panY: number; // canvas-space offset
}

interface CanvasTransformActions {
  setZoom(zoom: number, focalPoint?: { x: number; y: number }): void;
  setPan(x: number, y: number): void;
  zoomIn(): void; // step: 0.1
  zoomOut(): void; // step: 0.1
  fitAll(): void; // zoom to fit all windows
  fitGroup(groupId: string): void; // zoom to fit group bounds
  fitWindow(windowId: string): void; // zoom to fit single window
  screenToCanvas(screenX: number, screenY: number): { x: number; y: number };
  canvasToScreen(canvasX: number, canvasY: number): { x: number; y: number };
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;
const INTERACTION_THRESHOLD = 0.6; // below this, windows show preview only
```

Transform is applied via CSS:

```css
.canvas-transform {
  transform-origin: 0 0;
  transform: scale(var(--canvas-zoom))
    translate(var(--canvas-pan-x), var(--canvas-pan-y));
}
```

Zoom focuses on the cursor position (focal point zoom): adjusting panX/panY so the point under the cursor stays fixed during zoom.

### Canvas Groups

```typescript
// shell/src/stores/canvas-groups.ts
interface CanvasGroup {
  id: string;
  label: string;
  color: string; // group border/header color
  windowIds: string[]; // member window IDs
  collapsed: boolean; // collapsed = show label only, hide windows
}

interface CanvasGroupActions {
  createGroup(label: string, windowIds: string[]): string;
  deleteGroup(id: string): void;
  renameGroup(id: string, label: string): void;
  setGroupColor(id: string, color: string): void;
  addToGroup(groupId: string, windowId: string): void;
  removeFromGroup(groupId: string, windowId: string): void;
  toggleCollapsed(id: string): void;
  getGroupBounds(
    id: string,
  ): { x: number; y: number; width: number; height: number } | null;
}
```

Groups are persisted alongside layout in `~/system/canvas.json`:

```json
{
  "transform": { "zoom": 1.0, "panX": 0, "panY": 0 },
  "groups": [
    {
      "id": "grp-1",
      "label": "Work",
      "color": "#3b82f6",
      "windowIds": ["win-abc", "win-def"],
      "collapsed": false
    }
  ]
}
```

Group bounds are auto-calculated from member windows (bounding box + padding). Groups render as a labeled rectangle behind their member windows.

### Minimap

```typescript
// shell/src/components/canvas/CanvasMinimap.tsx
// Fixed-size (200x140) panel in bottom-right corner
// Renders:
//   - Scaled representation of all windows (colored rectangles)
//   - Group outlines
//   - Viewport indicator (semi-transparent rectangle showing visible area)
// Interactions:
//   - Click: pan canvas to center on clicked point
//   - Drag viewport indicator: live pan
```

The minimap calculates a scale factor from the total canvas bounds (all windows + padding) to the minimap dimensions. It uses a simple `<canvas>` element for rendering (not React DOM) for performance.

### Interactive vs Preview Mode

When `zoom < INTERACTION_THRESHOLD` (0.6):

- Iframes are replaced with a static preview (CSS `pointer-events: none` + screenshot or app title card)
- Window chrome is simplified (title only, no traffic lights)
- Drag is enabled on the entire window (not just title bar)

When `zoom >= INTERACTION_THRESHOLD`:

- Full iframe rendering with interaction
- Normal window chrome with traffic lights, resize handle
- Drag only on title bar (normal behavior)

This prevents the expensive "iframe at 10% zoom trying to capture events" problem and keeps the canvas responsive when zoomed out.

### Keyboard Shortcuts

| Shortcut     | Action                             |
| ------------ | ---------------------------------- |
| Space + drag | Pan canvas                         |
| Scroll wheel | Zoom in/out (focal point)          |
| Cmd/Ctrl + 0 | Fit all windows                    |
| Cmd/Ctrl + 1 | Zoom to 100%                       |
| Cmd/Ctrl + + | Zoom in                            |
| Cmd/Ctrl + - | Zoom out                           |
| Cmd/Ctrl + G | Group selected windows             |
| Escape       | Deselect all / exit selection mode |

### Gateway Endpoints

| Method | Path        | Description                           |
| ------ | ----------- | ------------------------------------- |
| GET    | /api/canvas | Read canvas.json (transform + groups) |
| PUT    | /api/canvas | Write canvas.json                     |

Canvas state is separate from layout.json. Layout stores window positions (shared between desktop and canvas modes). Canvas stores the transform and groups (canvas-mode only).

## Dependencies

- Phase 031 (desktop customization) -- complete (mode system, dock config)
- No backend dependencies beyond a simple file read/write endpoint

## New Files

| File                                              | Purpose                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| `shell/src/hooks/useWindowManager.ts`             | Extracted window state + operations (Zustand)          |
| `shell/src/hooks/useCanvasTransform.ts`           | Zoom/pan state + coordinate transforms                 |
| `shell/src/stores/canvas-groups.ts`               | Group state + persistence                              |
| `shell/src/components/canvas/CanvasRenderer.tsx`  | Canvas mode root component                             |
| `shell/src/components/canvas/CanvasTransform.tsx` | Pan/zoom container with pointer event handling         |
| `shell/src/components/canvas/CanvasWindow.tsx`    | Window chrome adapted for canvas (preview/interactive) |
| `shell/src/components/canvas/CanvasGroup.tsx`     | Visual group rectangle with label                      |
| `shell/src/components/canvas/CanvasMinimap.tsx`   | Navigation minimap (canvas element)                    |
| `shell/src/components/canvas/CanvasToolbar.tsx`   | Zoom controls, fit buttons, snap toggle                |
| `shell/src/components/canvas/SelectionRect.tsx`   | Drag-select rectangle for grouping                     |
| `home/system/canvas.json`                         | Default canvas state template                          |
| `home/agents/knowledge/canvas-mode.md`            | AI knowledge for canvas commands                       |
| `tests/shell/window-manager.test.ts`              | Window manager store tests                             |
| `tests/shell/canvas-transform.test.ts`            | Zoom/pan/coordinate transform tests                    |
| `tests/shell/canvas-groups.test.ts`               | Group CRUD + bounds calculation tests                  |
| `tests/shell/canvas-minimap.test.ts`              | Minimap scale + viewport tests                         |
| `tests/gateway/canvas-api.test.ts`                | Canvas API endpoint tests                              |

## Modified Files

| File                               | Changes                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `shell/src/components/Desktop.tsx` | Extract window logic to useWindowManager, delegate to DesktopRenderer or CanvasRenderer based on mode |
| `shell/src/stores/desktop-mode.ts` | Add `"canvas"` to DesktopMode union and MODE_CONFIGS                                                  |
| `shell/src/app/globals.css`        | Canvas transform styles, minimap styles                                                               |
| `packages/gateway/src/server.ts`   | Add GET/PUT `/api/canvas` endpoints                                                                   |
| `home/system/canvas.json`          | Template file for first-boot                                                                          |

## UX Considerations

- **First-time canvas**: When switching to canvas mode for the first time, auto-arrange existing windows in a grid layout and set zoom to fit all. Don't make users manually place everything.
- **Mode switching preserves positions**: Window x/y positions are the same in desktop and canvas mode. Switching modes doesn't rearrange anything -- canvas just adds zoom/pan/groups on top.
- **Touch support**: Pinch-to-zoom and two-finger pan for trackpad/tablet users.
- **Performance**: At >20 windows, zoomed-out mode must stay at 60fps. Preview mode (no iframes) ensures this.
- **Animation**: Zoom-to-fit uses 300ms ease-out transition. Pan/zoom during interaction is instant (no animation).

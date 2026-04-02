# Spec 054: Canvas UX Improvements

## Summary

Three targeted improvements to the Canvas mode UX: navigation mode toggle (scroll vs grab), redesigned window title bars (attached frosted strip), and smart window sizing with position memory.

## 1. Navigation Mode Toggle

### Current Behavior
- Two-finger scroll = pan (Figma-style)
- Pinch = zoom
- Space+click or middle-click = pan
- No alternative navigation mode

### New Behavior

A `canvasNavMode` setting stored in `useCanvasSettings` zustand store, persisted to `/api/canvas`.

**Scroll mode** (default, current):
- Two-finger scroll = pan
- Pinch = zoom

**Grab mode**:
- Left-click drag on empty canvas background = pan
- Scroll = disabled (no-op)
- Pinch = zoom (unchanged)
- Space+click and middle-click still work as pan shortcuts

### UI

Segmented toggle in `CanvasToolbar` after the grid toggle:
- Mouse icon = Scroll mode
- Hand icon = Grab mode
- Active mode gets `bg-muted text-foreground` styling (matches grid toggle pattern)

### Implementation

- New store: `shell/src/stores/canvas-settings.ts` with `navMode: "scroll" | "grab"` and `showTitles: boolean`
- `CanvasTransform.tsx`: check `navMode` in `onWheel` handler -- if `"grab"`, skip scroll-to-pan. In `onPointerDown`, if `"grab"` and left-click on background, start panning.
- Persist alongside existing canvas data in `/api/canvas` payload.

## 2. Window Title Bar Redesign (Attached Frosted Strip)

### Current State
- Title text + maximize/close float above the window with no background
- Sparse appearance, unclear drag affordance
- Visually disconnected from the window

### New Design

A 28px frosted glass bar attached to the top edge of the window frame, overlaying content:

```
+--[icon] App Title---------[zoom-to-fit] [close]--+
|                                                    |
|                  (app content)                     |
|                                                    |
+----------------------------------------------------+
```

**Styling:**
- `absolute top-0 left-0 right-0 h-7`
- `bg-card/80 backdrop-blur-sm border-b border-border/30`
- `rounded-t-lg` (matches window corner radius)
- App icon: 16px, from `iconUrl`, with fallback to first letter
- Title: `text-xs font-medium truncate`
- Buttons: `size-3.5`, hover opacity transition

**Behavior:**
- Entire bar is the drag handle (`cursor: grab / grabbing`)
- When zoomed in (`zoom >= INTERACTION_THRESHOLD`): bar fades in on hover (`opacity-0 hover:opacity-100 transition-opacity`), with a small delay so it doesn't flicker
- When zoomed out: bar always visible (needed for identification)
- `pointerEvents: "auto"` on the bar even when content has overlay during drag

**Show/Hide Toggle:**
- New toggle in CanvasToolbar: Eye icon
- Stored as `showTitles` in `useCanvasSettings`
- When hidden: no title bar rendered at all (clean view)
- Default: visible

## 3. Smart Window Sizing + Position Memory

### Current State
- All windows open at hardcoded 640x480
- Position cascades by `state.windows.length * 30` offset
- Layout is saved/restored via `/api/layout`, but `openWindow` doesn't check saved layout for previously-closed apps

### New Default Size

Replace hardcoded 640x480 with viewport-relative:

```typescript
const defaultWidth = Math.round(window.innerWidth * 0.8);
const defaultHeight = Math.round(window.innerHeight * 0.8);
```

Clamped to `MIN_WIDTH` (320) minimum and viewport max.

### Position Memory

When `openWindow` is called for a path:
1. Check `closedPaths` -- if the path was previously closed, look up its saved layout entry
2. If found: restore `x, y, width, height` from the saved entry
3. If not found: use 80% viewport defaults + cascade offset

Implementation in `useWindowManager.openWindow`:
- Add a `closedLayouts` Map that stores `{ x, y, width, height }` when a window is closed
- On open, check this map first before falling back to defaults

### Layout Save

Already implemented via `debouncedSave` -- closed windows with their positions are included in the save payload. No changes needed to the save path.

## Files to Modify

| File | Change |
|------|--------|
| `shell/src/stores/canvas-settings.ts` | New store: `navMode`, `showTitles` |
| `shell/src/components/canvas/CanvasTransform.tsx` | Grab mode panning, scroll disable |
| `shell/src/components/canvas/CanvasToolbar.tsx` | Nav mode toggle, show titles toggle |
| `shell/src/components/canvas/CanvasWindow.tsx` | Frosted strip title bar redesign |
| `shell/src/components/canvas/CanvasRenderer.tsx` | Pass settings to children, persist |
| `shell/src/hooks/useWindowManager.ts` | 80% viewport sizing, position memory via closedLayouts |

## Out of Scope

- Per-app `preferredSize` in meta.json (future enhancement)
- Title bar approach A/B alternatives
- Keyboard shortcut for nav mode toggle

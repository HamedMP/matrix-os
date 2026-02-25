# Plan: Canvas Desktop Mode

**Spec**: `specs/035-canvas-desktop/spec.md`
**Depends on**: Phase 031 (complete)
**Estimated effort**: Large (20 tasks + TDD)

## Approach

The critical path is extracting the window manager from Desktop.tsx before building anything canvas-specific. Today all window state and operations are inline in a single component -- that monolith must be split before we can have two renderers (desktop vs canvas) consuming the same state.

After extraction, build the canvas primitives (transform, zoom/pan) before the UX features (groups, minimap, toolbar). The transform layer is the foundation everything else sits on.

### Phase A: Window Manager Extraction (T1250-T1253)

The riskiest and most important phase. Refactor without changing behavior -- extract state and operations from Desktop.tsx into a Zustand store. Both the existing desktop renderer and the future canvas renderer will consume this store.

1. Create `useWindowManager` Zustand store with all window CRUD operations
2. Move layout persistence (debounced PUT /api/layout) into the store
3. Refactor Desktop.tsx to consume the store instead of local useState
4. Verify zero behavior change (all existing tests pass, manual smoke test)

### Phase B: Canvas Transform (T1255-T1259)

Build the pan/zoom foundation. This is pure math + CSS transforms -- no visual design needed yet.

1. `useCanvasTransform` hook: zoom, panX, panY state + focal-point zoom math
2. `CanvasTransform` component: CSS transform container with pointer event handlers
3. Pan: Space+drag, middle-click drag, two-finger trackpad
4. Zoom: scroll wheel with focal point, pinch-to-zoom, keyboard shortcuts
5. Coordinate conversion: screenToCanvas / canvasToScreen utilities
6. Animated transitions: zoom-to-fit uses 300ms ease-out

### Phase C: Canvas Renderer (T1260-T1265)

Wire the transform into a working canvas desktop that renders windows.

1. `CanvasRenderer` component: wrapper that switches between desktop and canvas rendering
2. `CanvasWindow` component: window chrome adapted for zoom levels (interactive vs preview)
3. Interactive threshold: zoom >= 0.6 = full iframe, zoom < 0.6 = preview card
4. Wire into Desktop.tsx: mode-based rendering (desktop mode -> existing, canvas mode -> CanvasRenderer)
5. Add `"canvas"` to desktop-mode.ts MODE_CONFIGS
6. Gateway endpoints: GET/PUT `/api/canvas`

### Phase D: Groups (T1268-T1272)

Spatial organization -- the key differentiator over regular windowed desktop.

1. `canvas-groups.ts` Zustand store: group CRUD, membership, collapse/expand
2. `CanvasGroup` component: labeled rectangle behind member windows, auto-sized bounds
3. `SelectionRect` component: drag-select to create groups
4. Group persistence in `~/system/canvas.json`
5. Group interactions: drag to move group (moves all members), double-click to zoom-to-fit
6. Cmd+G keyboard shortcut to group selection

### Phase E: Navigation & Polish (T1275-T1279)

Minimap, toolbar, first-time experience, and AI knowledge.

1. `CanvasMinimap`: scaled canvas view with viewport indicator, click-to-pan
2. `CanvasToolbar`: zoom slider, percentage display, fit-all/fit-selection buttons, grid snap toggle
3. First-time auto-arrange: when entering canvas mode with no canvas.json, auto-grid existing windows
4. AI knowledge file: canvas commands via chat ("group these apps", "zoom to Work group")

## Files to Create

- `shell/src/hooks/useWindowManager.ts`
- `shell/src/hooks/useCanvasTransform.ts`
- `shell/src/stores/canvas-groups.ts`
- `shell/src/components/canvas/CanvasRenderer.tsx`
- `shell/src/components/canvas/CanvasTransform.tsx`
- `shell/src/components/canvas/CanvasWindow.tsx`
- `shell/src/components/canvas/CanvasGroup.tsx`
- `shell/src/components/canvas/CanvasMinimap.tsx`
- `shell/src/components/canvas/CanvasToolbar.tsx`
- `shell/src/components/canvas/SelectionRect.tsx`
- `home/system/canvas.json`
- `home/agents/knowledge/canvas-mode.md`
- All corresponding test files

## Files to Modify

- `shell/src/components/Desktop.tsx` -- extract to useWindowManager, add mode switch
- `shell/src/stores/desktop-mode.ts` -- add `"canvas"` mode
- `shell/src/app/globals.css` -- canvas styles
- `packages/gateway/src/server.ts` -- canvas API endpoints

## Critical Risks

1. **Desktop.tsx refactor regression**: The extraction must not change any existing behavior. Run all tests + manual smoke test after Phase A before proceeding.
2. **iframe performance at scale**: Zoomed-out view with 20+ iframes will lag. The preview threshold (zoom < 0.6 = no iframes) is essential -- don't skip it.
3. **Pointer event conflicts**: Pan/zoom gestures can conflict with window drag and iframe interactions. Careful event handling is needed (stopPropagation boundaries, pointer-capture management).

## Verification

1. Switch to canvas mode -- existing windows appear at their saved positions
2. Scroll wheel zooms in/out centered on cursor
3. Space+drag pans the canvas smoothly
4. Zoom out below 0.6 -- iframes become preview cards, canvas stays responsive
5. Drag-select multiple windows, press Cmd+G -- group created with label
6. Double-click group label -- canvas zooms to fit the group
7. Minimap shows all windows, click to navigate
8. Switch back to desktop mode -- windows in same positions, no data loss
9. Refresh page -- canvas transform and groups restored from canvas.json
10. `bun run test` passes (all new + existing tests)

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.1;
export const INTERACTION_THRESHOLD = 0.25;

const FIT_PADDING = 50;

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Maximum pan distance from origin in canvas units. Prevents getting lost. */
const PAN_LIMIT = 8000;

interface ContainerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CanvasTransformState {
  zoom: number;
  panX: number;
  panY: number;
  isAnimating: boolean;
  /** True while the user is actively scrolling/wheeling the canvas. */
  isScrolling: boolean;
  containerRect: ContainerRect | null;
}

interface CanvasTransformActions {
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  zoomAtPoint: (newZoom: number, cx: number, cy: number) => void;
  setPan: (x: number, y: number) => void;
  panBy: (dx: number, dy: number) => void;
  setIsScrolling: (v: boolean) => void;
  setContainerRect: (rect: ContainerRect | null) => void;
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  fitAll: (windows: WindowRect[], viewportW: number, viewportH: number) => void;
  focusOnWindow: (win: WindowRect, viewportW: number, viewportH: number) => void;
  zoomToWindow: (win: WindowRect, viewportW: number, viewportH: number) => void;
  setTransform: (zoom: number, panX: number, panY: number) => void;
  resetForMobileViewport: () => void;
}

// Duration of the programmatic zoom animation; kept in sync with the CSS
// transition in CanvasTransform. Exported so the view can read one value.
export const ZOOM_ANIM_MS = 460;

let zoomAnimTimer: ReturnType<typeof setTimeout> | null = null;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const useCanvasTransform = create<CanvasTransformState & CanvasTransformActions>()(
  subscribeWithSelector((set, get) => ({
    zoom: 1,
    panX: 0,
    panY: 0,
    isAnimating: false,
    isScrolling: false,
    containerRect: null,

    setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),

    zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom + ZOOM_STEP) })),

    zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom - ZOOM_STEP) })),

    resetZoom: () => set({ zoom: 1 }),

    zoomAtPoint: (newZoom, cx, cy) => {
      const clamped = clampZoom(newZoom);
      const rect = get().containerRect;
      const lx = cx - (rect?.left ?? 0);
      const ly = cy - (rect?.top ?? 0);
      set((s) => ({
        zoom: clamped,
        panX: s.panX + lx * (1 / clamped - 1 / s.zoom),
        panY: s.panY + ly * (1 / clamped - 1 / s.zoom),
      }));
    },

    setPan: (x, y) => set({ panX: x, panY: y }),

    panBy: (dx, dy) => set((s) => ({
      panX: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, s.panX + dx)),
      panY: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, s.panY + dy)),
    })),

    setIsScrolling: (v) => { if (get().isScrolling !== v) set({ isScrolling: v }); },

    setContainerRect: (rect) => set({ containerRect: rect }),

    screenToCanvas: (sx, sy) => {
      const { zoom, panX, panY, containerRect } = get();
      const lx = sx - (containerRect?.left ?? 0);
      const ly = sy - (containerRect?.top ?? 0);
      return {
        x: lx / zoom - panX,
        y: ly / zoom - panY,
      };
    },

    canvasToScreen: (cx, cy) => {
      const { zoom, panX, panY, containerRect } = get();
      return {
        x: (cx + panX) * zoom + (containerRect?.left ?? 0),
        y: (cy + panY) * zoom + (containerRect?.top ?? 0),
      };
    },

    fitAll: (windows, viewportW, viewportH) => {
      if (windows.length === 0) {
        set({ zoom: 1, panX: 0, panY: 0 });
        return;
      }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of windows) {
        minX = Math.min(minX, w.x);
        minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x + w.width);
        maxY = Math.max(maxY, w.y + w.height);
      }

      const contentW = maxX - minX;
      const contentH = maxY - minY;
      const availW = viewportW - FIT_PADDING * 2;
      const availH = viewportH - FIT_PADDING * 2;

      const zoom = clampZoom(Math.min(availW / contentW, availH / contentH));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const panX = viewportW / (2 * zoom) - centerX;
      const panY = viewportH / (2 * zoom) - centerY;

      set({ zoom, panX, panY });
    },

    focusOnWindow: (win, viewportW, viewportH) => {
      const { zoom } = get();
      const centerX = win.x + win.width / 2;
      const centerY = win.y + win.height / 2;
      const panX = viewportW / (2 * zoom) - centerX;
      const panY = viewportH / (2 * zoom) - centerY;
      set({ panX, panY });
    },

    // Zoom so a single window fills the viewport (minus padding) and center it.
    // Used by double-clicking an app's title bar to "zoom into" that app. The
    // transform change is eased (with a gentle overshoot) via a CSS transition
    // gated on `isAnimating` in CanvasTransform — so the jump isn't abrupt.
    zoomToWindow: (win, viewportW, viewportH) => {
      const availW = viewportW - FIT_PADDING * 2;
      const availH = viewportH - FIT_PADDING * 2;
      const zoom = clampZoom(Math.min(availW / win.width, availH / win.height));
      const centerX = win.x + win.width / 2;
      const centerY = win.y + win.height / 2;
      const panX = viewportW / (2 * zoom) - centerX;
      const panY = viewportH / (2 * zoom) - centerY;

      if (prefersReducedMotion()) {
        set({ zoom, panX, panY, isAnimating: false });
        return;
      }
      if (zoomAnimTimer) clearTimeout(zoomAnimTimer);
      // Flip on the eased transition, then set the target transform in the same
      // commit so React applies both together and the browser animates to it.
      set({ zoom, panX, panY, isAnimating: true });
      zoomAnimTimer = setTimeout(() => {
        set({ isAnimating: false });
        zoomAnimTimer = null;
      }, ZOOM_ANIM_MS);
    },

    setTransform: (zoom, panX, panY) => set({ zoom: clampZoom(zoom), panX, panY }),

    resetForMobileViewport: () => set({ zoom: 1, panX: 0, panY: 0, isScrolling: false, isAnimating: false }),
  })),
);

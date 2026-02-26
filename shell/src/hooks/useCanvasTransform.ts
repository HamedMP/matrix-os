import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.1;
export const INTERACTION_THRESHOLD = 0.6;

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

interface CanvasTransformState {
  zoom: number;
  panX: number;
  panY: number;
  isAnimating: boolean;
}

interface CanvasTransformActions {
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  zoomAtPoint: (newZoom: number, cx: number, cy: number) => void;
  setPan: (x: number, y: number) => void;
  panBy: (dx: number, dy: number) => void;
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  fitAll: (windows: WindowRect[], viewportW: number, viewportH: number) => void;
  setTransform: (zoom: number, panX: number, panY: number) => void;
}

export const useCanvasTransform = create<CanvasTransformState & CanvasTransformActions>()(
  subscribeWithSelector((set, get) => ({
    zoom: 1,
    panX: 0,
    panY: 0,
    isAnimating: false,

    setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),

    zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom + ZOOM_STEP) })),

    zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom - ZOOM_STEP) })),

    resetZoom: () => set({ zoom: 1 }),

    zoomAtPoint: (newZoom, cx, cy) => {
      const clamped = clampZoom(newZoom);
      set((s) => ({
        zoom: clamped,
        panX: s.panX + cx * (1 / clamped - 1 / s.zoom),
        panY: s.panY + cy * (1 / clamped - 1 / s.zoom),
      }));
    },

    setPan: (x, y) => set({ panX: x, panY: y }),

    panBy: (dx, dy) => set((s) => ({ panX: s.panX + dx, panY: s.panY + dy })),

    screenToCanvas: (sx, sy) => {
      const { zoom, panX, panY } = get();
      return {
        x: (sx - panX * zoom) / zoom,
        y: (sy - panY * zoom) / zoom,
      };
    },

    canvasToScreen: (cx, cy) => {
      const { zoom, panX, panY } = get();
      return {
        x: (cx + panX) * zoom,
        y: (cy + panY) * zoom,
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

    setTransform: (zoom, panX, panY) => set({ zoom: clampZoom(zoom), panX, panY }),
  })),
);

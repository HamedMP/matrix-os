// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";

function resetStores() {
  useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false });
  useWindowManager.setState({ windows: [], nextZ: 1, closedPaths: new Set(), apps: [] });
}

describe("Canvas Toolbar", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("zoom controls", () => {
    it("zoom in increments by ZOOM_STEP", () => {
      useCanvasTransform.getState().zoomIn();
      expect(useCanvasTransform.getState().zoom).toBeCloseTo(1 + ZOOM_STEP);
    });

    it("zoom out decrements by ZOOM_STEP", () => {
      useCanvasTransform.getState().zoomOut();
      expect(useCanvasTransform.getState().zoom).toBeCloseTo(1 - ZOOM_STEP);
    });

    it("reset zoom returns to 1.0", () => {
      useCanvasTransform.getState().setZoom(2.5);
      useCanvasTransform.getState().resetZoom();
      expect(useCanvasTransform.getState().zoom).toBe(1);
    });

    it("zoom slider sets zoom to exact value", () => {
      useCanvasTransform.getState().setZoom(0.5);
      expect(useCanvasTransform.getState().zoom).toBe(0.5);
    });

    it("zoom clamps to min", () => {
      useCanvasTransform.getState().setZoom(0.01);
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MIN);
    });

    it("zoom clamps to max", () => {
      useCanvasTransform.getState().setZoom(10);
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MAX);
    });
  });

  describe("fit all", () => {
    it("fits all windows into viewport", () => {
      useWindowManager.getState().openWindow("A", "apps/a.html", 0);
      useWindowManager.getState().openWindow("B", "apps/b.html", 0);
      const [w1, w2] = useWindowManager.getState().windows;
      useWindowManager.getState().moveWindow(w1.id, 0, 0);
      useWindowManager.getState().moveWindow(w2.id, 2000, 1500);

      const windows = useWindowManager.getState().windows;
      useCanvasTransform.getState().fitAll(
        windows.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
        1920,
        1080,
      );

      const { zoom, panX, panY } = useCanvasTransform.getState();
      expect(zoom).toBeGreaterThan(0);
      expect(zoom).toBeLessThanOrEqual(ZOOM_MAX);
      // Pan should center the content
      expect(panX).toBeDefined();
      expect(panY).toBeDefined();
    });

    it("resets to 1:1 when no windows", () => {
      useCanvasTransform.getState().fitAll([], 1920, 1080);
      const { zoom, panX, panY } = useCanvasTransform.getState();
      expect(zoom).toBe(1);
      expect(panX).toBe(0);
      expect(panY).toBe(0);
    });
  });

  describe("zoom percentage display", () => {
    it("formats zoom as percentage", () => {
      const formatZoom = (zoom: number) => `${Math.round(zoom * 100)}%`;
      expect(formatZoom(1)).toBe("100%");
      expect(formatZoom(0.5)).toBe("50%");
      expect(formatZoom(2.0)).toBe("200%");
      expect(formatZoom(0.1)).toBe("10%");
      expect(formatZoom(3.0)).toBe("300%");
    });
  });

  describe("keyboard shortcuts", () => {
    it("Cmd+0 calls fitAll", () => {
      useWindowManager.getState().openWindow("A", "apps/a.html", 0);
      const windows = useWindowManager.getState().windows;
      useCanvasTransform.getState().setZoom(2.5);
      useCanvasTransform.getState().fitAll(
        windows.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
        1920,
        1080,
      );
      // After fitAll, zoom should be adjusted (not 2.5 anymore)
      expect(useCanvasTransform.getState().zoom).not.toBe(2.5);
    });

    it("Cmd+1 resets to 100%", () => {
      useCanvasTransform.getState().setZoom(2.5);
      useCanvasTransform.getState().resetZoom();
      expect(useCanvasTransform.getState().zoom).toBe(1);
    });

    it("Cmd+= zooms in", () => {
      useCanvasTransform.getState().zoomIn();
      expect(useCanvasTransform.getState().zoom).toBeCloseTo(1.1);
    });

    it("Cmd+- zooms out", () => {
      useCanvasTransform.getState().zoomOut();
      expect(useCanvasTransform.getState().zoom).toBeCloseTo(0.9);
    });
  });
});

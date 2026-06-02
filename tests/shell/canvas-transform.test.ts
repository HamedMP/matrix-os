// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useCanvasTransform, ZOOM_ANIM_MS, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "../../shell/src/hooks/useCanvasTransform.js";

function reset() {
  useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false });
}

describe("Canvas Transform Store", () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("zoom", () => {
    it("defaults to zoom 1, pan (0,0)", () => {
      const s = useCanvasTransform.getState();
      expect(s.zoom).toBe(1);
      expect(s.panX).toBe(0);
      expect(s.panY).toBe(0);
    });

    it("zoomIn increases zoom by ZOOM_STEP", () => {
      useCanvasTransform.getState().zoomIn();
      expect(useCanvasTransform.getState().zoom).toBeCloseTo(1 + ZOOM_STEP);
    });

    it("zoomOut decreases zoom by ZOOM_STEP", () => {
      useCanvasTransform.getState().zoomOut();
      expect(useCanvasTransform.getState().zoom).toBeCloseTo(1 - ZOOM_STEP);
    });

    it("clamps zoom to ZOOM_MIN", () => {
      useCanvasTransform.setState({ zoom: ZOOM_MIN });
      useCanvasTransform.getState().zoomOut();
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MIN);
    });

    it("clamps zoom to ZOOM_MAX", () => {
      useCanvasTransform.setState({ zoom: ZOOM_MAX });
      useCanvasTransform.getState().zoomIn();
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MAX);
    });

    it("setZoom sets exact zoom level (clamped)", () => {
      useCanvasTransform.getState().setZoom(2.5);
      expect(useCanvasTransform.getState().zoom).toBe(2.5);
      useCanvasTransform.getState().setZoom(10);
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MAX);
      useCanvasTransform.getState().setZoom(0.01);
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MIN);
    });

    it("resetZoom sets zoom to 1", () => {
      useCanvasTransform.setState({ zoom: 2 });
      useCanvasTransform.getState().resetZoom();
      expect(useCanvasTransform.getState().zoom).toBe(1);
    });
  });

  describe("pan", () => {
    it("setPan updates panX and panY", () => {
      useCanvasTransform.getState().setPan(100, 200);
      const s = useCanvasTransform.getState();
      expect(s.panX).toBe(100);
      expect(s.panY).toBe(200);
    });

    it("panBy adds delta to current pan", () => {
      useCanvasTransform.setState({ panX: 50, panY: 50 });
      useCanvasTransform.getState().panBy(10, -20);
      const s = useCanvasTransform.getState();
      expect(s.panX).toBe(60);
      expect(s.panY).toBe(30);
    });
  });

  describe("focal point zoom", () => {
    it("preserves focal point when zooming in", () => {
      useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0 });
      // Canvas point under cursor at (400, 300) before zoom
      const canvasBefore = useCanvasTransform.getState().screenToCanvas(400, 300);

      useCanvasTransform.getState().zoomAtPoint(1.5, 400, 300);
      expect(useCanvasTransform.getState().zoom).toBe(1.5);

      // Same canvas point should still be at screen (400, 300)
      const screenAfter = useCanvasTransform.getState().canvasToScreen(canvasBefore.x, canvasBefore.y);
      expect(screenAfter.x).toBeCloseTo(400);
      expect(screenAfter.y).toBeCloseTo(300);
    });

    it("preserves focal point when zooming out", () => {
      useCanvasTransform.setState({ zoom: 2, panX: -100, panY: -100 });
      const canvasBefore = useCanvasTransform.getState().screenToCanvas(400, 300);

      useCanvasTransform.getState().zoomAtPoint(1, 400, 300);
      expect(useCanvasTransform.getState().zoom).toBe(1);

      const screenAfter = useCanvasTransform.getState().canvasToScreen(canvasBefore.x, canvasBefore.y);
      expect(screenAfter.x).toBeCloseTo(400);
      expect(screenAfter.y).toBeCloseTo(300);
    });

    it("preserves focal point with non-zero pan", () => {
      useCanvasTransform.setState({ zoom: 1.5, panX: -200, panY: 100 });
      const canvasBefore = useCanvasTransform.getState().screenToCanvas(600, 400);

      useCanvasTransform.getState().zoomAtPoint(2.5, 600, 400);
      expect(useCanvasTransform.getState().zoom).toBe(2.5);

      const screenAfter = useCanvasTransform.getState().canvasToScreen(canvasBefore.x, canvasBefore.y);
      expect(screenAfter.x).toBeCloseTo(600);
      expect(screenAfter.y).toBeCloseTo(400);
    });

    it("clamps zoom at point to bounds", () => {
      useCanvasTransform.getState().zoomAtPoint(ZOOM_MAX + 1, 0, 0);
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MAX);
      useCanvasTransform.getState().zoomAtPoint(0, 0, 0);
      expect(useCanvasTransform.getState().zoom).toBe(ZOOM_MIN);
    });
  });

  describe("coordinate conversion", () => {
    it("screenToCanvas converts screen coords to canvas coords", () => {
      useCanvasTransform.setState({ zoom: 2, panX: -100, panY: -50 });
      const { screenToCanvas } = useCanvasTransform.getState();
      const result = screenToCanvas(400, 300);
      // canvasX = (screenX - panX * zoom) / zoom = (400 - (-100*2)) / 2 = (400+200)/2 = 300
      // canvasY = (screenY - panY * zoom) / zoom = (300 - (-50*2)) / 2 = (300+100)/2 = 200
      expect(result.x).toBeCloseTo(300);
      expect(result.y).toBeCloseTo(200);
    });

    it("canvasToScreen converts canvas coords to screen coords", () => {
      useCanvasTransform.setState({ zoom: 2, panX: -100, panY: -50 });
      const { canvasToScreen } = useCanvasTransform.getState();
      const result = canvasToScreen(300, 200);
      // screenX = (canvasX + panX) * zoom = (300 + (-100)) * 2 = 400
      // screenY = (canvasY + panY) * zoom = (200 + (-50)) * 2 = 300
      expect(result.x).toBeCloseTo(400);
      expect(result.y).toBeCloseTo(300);
    });

    it("round-trip: screenToCanvas -> canvasToScreen returns original", () => {
      useCanvasTransform.setState({ zoom: 1.5, panX: -200, panY: 100 });
      const { screenToCanvas, canvasToScreen } = useCanvasTransform.getState();
      const canvas = screenToCanvas(500, 400);
      const screen = canvasToScreen(canvas.x, canvas.y);
      expect(screen.x).toBeCloseTo(500);
      expect(screen.y).toBeCloseTo(400);
    });
  });

  describe("fitAll", () => {
    it("fits a bounding box into a viewport with padding", () => {
      const windows = [
        { x: 100, y: 100, width: 200, height: 150 },
        { x: 500, y: 400, width: 300, height: 200 },
      ];
      useCanvasTransform.getState().fitAll(windows, 1200, 800);

      const s = useCanvasTransform.getState();
      // Bounding box: x 100..800, y 100..600 => w=700, h=500
      // Viewport (with 50px padding each side): 1100x700
      // Scale: min(1100/700, 700/500) = min(1.571, 1.4) = 1.4
      // Clamped to ZOOM_MAX=3 if needed
      expect(s.zoom).toBeGreaterThan(0);
      expect(s.zoom).toBeLessThanOrEqual(ZOOM_MAX);
    });

    it("handles empty window list gracefully", () => {
      useCanvasTransform.setState({ zoom: 2, panX: -100, panY: -100 });
      useCanvasTransform.getState().fitAll([], 1200, 800);
      const s = useCanvasTransform.getState();
      expect(s.zoom).toBe(1);
      expect(s.panX).toBe(0);
      expect(s.panY).toBe(0);
    });

    it("handles single window", () => {
      useCanvasTransform.getState().fitAll(
        [{ x: 100, y: 100, width: 640, height: 480 }],
        1200,
        800,
      );
      const s = useCanvasTransform.getState();
      expect(s.zoom).toBeGreaterThan(0);
    });
  });

  describe("isAnimating flag", () => {
    it("defaults to false", () => {
      expect(useCanvasTransform.getState().isAnimating).toBe(false);
    });

    it("can be set to true", () => {
      useCanvasTransform.setState({ isAnimating: true });
      expect(useCanvasTransform.getState().isAnimating).toBe(true);
    });

    it("zoomAtPoint cancels a programmatic zoom animation", () => {
      vi.useFakeTimers();
      useCanvasTransform.getState().zoomToWindow({ x: 0, y: 0, width: 400, height: 300 }, 1200, 800);
      expect(useCanvasTransform.getState().isAnimating).toBe(true);

      useCanvasTransform.getState().zoomAtPoint(1.2, 400, 300);

      expect(useCanvasTransform.getState().isAnimating).toBe(false);
      vi.advanceTimersByTime(ZOOM_ANIM_MS);
      expect(useCanvasTransform.getState().isAnimating).toBe(false);
    });

    it("panBy cancels a programmatic zoom animation", () => {
      vi.useFakeTimers();
      useCanvasTransform.getState().zoomToWindow({ x: 0, y: 0, width: 400, height: 300 }, 1200, 800);
      expect(useCanvasTransform.getState().isAnimating).toBe(true);

      useCanvasTransform.getState().panBy(10, -20);

      expect(useCanvasTransform.getState().isAnimating).toBe(false);
      vi.advanceTimersByTime(ZOOM_ANIM_MS);
      expect(useCanvasTransform.getState().isAnimating).toBe(false);
    });

    it("toolbar zoom cancels a programmatic zoom animation", () => {
      vi.useFakeTimers();
      useCanvasTransform.getState().zoomToWindow({ x: 0, y: 0, width: 400, height: 300 }, 1200, 800);
      expect(useCanvasTransform.getState().isAnimating).toBe(true);

      useCanvasTransform.getState().zoomIn();

      expect(useCanvasTransform.getState().isAnimating).toBe(false);
      vi.advanceTimersByTime(ZOOM_ANIM_MS);
      expect(useCanvasTransform.getState().isAnimating).toBe(false);
    });

    it("fitAll cancels a programmatic zoom animation", () => {
      vi.useFakeTimers();
      useCanvasTransform.getState().zoomToWindow({ x: 0, y: 0, width: 400, height: 300 }, 1200, 800);
      expect(useCanvasTransform.getState().isAnimating).toBe(true);

      useCanvasTransform.getState().fitAll([{ x: 0, y: 0, width: 800, height: 600 }], 1200, 800);

      expect(useCanvasTransform.getState().isAnimating).toBe(false);
      vi.advanceTimersByTime(ZOOM_ANIM_MS);
      expect(useCanvasTransform.getState().isAnimating).toBe(false);
    });
  });

  describe("container offset", () => {
    function rect(left: number, top: number, width = 800, height = 600) {
      return { left, top, width, height };
    }

    afterEach(() => {
      useCanvasTransform.setState({ containerRect: null });
    });

    it("screenToCanvas subtracts container offset", () => {
      useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, containerRect: rect(250, 28) });
      const pt = useCanvasTransform.getState().screenToCanvas(500, 300);
      expect(pt.x).toBeCloseTo(250);
      expect(pt.y).toBeCloseTo(272);
    });

    it("canvasToScreen adds container offset", () => {
      useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, containerRect: rect(250, 28) });
      const pt = useCanvasTransform.getState().canvasToScreen(250, 272);
      expect(pt.x).toBeCloseTo(500);
      expect(pt.y).toBeCloseTo(300);
    });

    it("round-trip with container offset", () => {
      useCanvasTransform.setState({ zoom: 1.5, panX: -200, panY: 100, containerRect: rect(250, 28) });
      const { screenToCanvas, canvasToScreen } = useCanvasTransform.getState();
      const canvas = screenToCanvas(600, 400);
      const screen = canvasToScreen(canvas.x, canvas.y);
      expect(screen.x).toBeCloseTo(600);
      expect(screen.y).toBeCloseTo(400);
    });

    it("zoomAtPoint preserves focal point with container offset", () => {
      useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, containerRect: rect(250, 28) });
      const canvasBefore = useCanvasTransform.getState().screenToCanvas(500, 300);

      useCanvasTransform.getState().zoomAtPoint(2, 500, 300);
      expect(useCanvasTransform.getState().zoom).toBe(2);

      const screenAfter = useCanvasTransform.getState().canvasToScreen(canvasBefore.x, canvasBefore.y);
      expect(screenAfter.x).toBeCloseTo(500);
      expect(screenAfter.y).toBeCloseTo(300);
    });

    it("zoomAtPoint preserves focal point with offset and existing pan", () => {
      useCanvasTransform.setState({ zoom: 1.5, panX: -200, panY: 100, containerRect: rect(100, 50) });
      const canvasBefore = useCanvasTransform.getState().screenToCanvas(600, 400);

      useCanvasTransform.getState().zoomAtPoint(2.5, 600, 400);

      const screenAfter = useCanvasTransform.getState().canvasToScreen(canvasBefore.x, canvasBefore.y);
      expect(screenAfter.x).toBeCloseTo(600);
      expect(screenAfter.y).toBeCloseTo(400);
    });

    it("multiple zoom steps maintain focal point stability", () => {
      useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, containerRect: rect(200, 40) });
      const canvasBefore = useCanvasTransform.getState().screenToCanvas(500, 300);

      for (let z = 1.1; z <= 2.0; z += 0.1) {
        useCanvasTransform.getState().zoomAtPoint(z, 500, 300);
      }

      const screenAfter = useCanvasTransform.getState().canvasToScreen(canvasBefore.x, canvasBefore.y);
      expect(screenAfter.x).toBeCloseTo(500, 0);
      expect(screenAfter.y).toBeCloseTo(300, 0);
    });
  });
});

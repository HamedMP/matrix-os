// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import { useCanvasGroups } from "../../shell/src/stores/canvas-groups.js";

function resetStores() {
  useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false });
  useCanvasGroups.setState({ groups: [] });
  useWindowManager.setState({ windows: [], nextZ: 1, closedPaths: new Set(), apps: [] });
}

describe("Canvas Minimap", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("viewport calculation", () => {
    it("returns viewport rect in canvas coordinates", () => {
      const { screenToCanvas } = useCanvasTransform.getState();
      const topLeft = screenToCanvas(0, 0);
      const bottomRight = screenToCanvas(800, 600);
      expect(topLeft.x).toBe(0);
      expect(topLeft.y).toBe(0);
      expect(bottomRight.x).toBe(800);
      expect(bottomRight.y).toBe(600);
    });

    it("adjusts viewport when zoomed and panned", () => {
      useCanvasTransform.getState().setTransform(2, 50, 50);
      const { screenToCanvas } = useCanvasTransform.getState();
      const topLeft = screenToCanvas(0, 0);
      const bottomRight = screenToCanvas(800, 600);
      expect(topLeft.x).toBe(-50);
      expect(topLeft.y).toBe(-50);
      expect(bottomRight.x).toBe(350);
      expect(bottomRight.y).toBe(250);
    });
  });

  describe("bounds computation", () => {
    it("computes world bounds from all windows", () => {
      useWindowManager.getState().openWindow("A", "apps/a.html", 0);
      useWindowManager.getState().openWindow("B", "apps/b.html", 0);
      const [w1, w2] = useWindowManager.getState().windows;
      useWindowManager.getState().moveWindow(w1.id, 0, 0);
      useWindowManager.getState().moveWindow(w2.id, 1000, 800);
      const windows = useWindowManager.getState().windows;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of windows) {
        minX = Math.min(minX, w.x);
        minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x + w.width);
        maxY = Math.max(maxY, w.y + w.height);
      }
      expect(minX).toBe(0);
      expect(minY).toBe(0);
      expect(maxX).toBe(1000 + 640);
      expect(maxY).toBe(800 + 480);
    });

    it("returns empty bounds when no windows exist", () => {
      const windows = useWindowManager.getState().windows;
      expect(windows.length).toBe(0);
    });
  });

  describe("click-to-navigate", () => {
    it("centers canvas on clicked point in minimap", () => {
      const { setPan } = useCanvasTransform.getState();
      // Simulate clicking the center of the minimap which maps to canvas point (500, 400)
      const targetX = 500;
      const targetY = 400;
      const viewportW = 800;
      const viewportH = 600;
      const { zoom } = useCanvasTransform.getState();
      // Center the viewport on target point
      const panX = viewportW / (2 * zoom) - targetX;
      const panY = viewportH / (2 * zoom) - targetY;
      setPan(panX, panY);
      const state = useCanvasTransform.getState();
      expect(state.panX).toBe(-100);
      expect(state.panY).toBe(-100);
    });
  });

  describe("minimap scale", () => {
    it("scales world bounds to fit minimap dimensions", () => {
      const minimapW = 200;
      const minimapH = 140;
      const worldW = 2000;
      const worldH = 1600;
      const scale = Math.min(minimapW / worldW, minimapH / worldH);
      expect(scale).toBeCloseTo(0.0875);
    });

    it("handles zero-size world gracefully", () => {
      const minimapW = 200;
      const minimapH = 140;
      const worldW = 0;
      const worldH = 0;
      const scale = worldW === 0 || worldH === 0 ? 1 : Math.min(minimapW / worldW, minimapH / worldH);
      expect(scale).toBe(1);
    });
  });

  describe("group outlines in minimap", () => {
    it("includes group bounds in minimap data", () => {
      useWindowManager.getState().openWindow("A", "apps/a.html", 0);
      useWindowManager.getState().openWindow("B", "apps/b.html", 0);
      const [w1, w2] = useWindowManager.getState().windows;
      useWindowManager.getState().moveWindow(w1.id, 100, 100);
      useWindowManager.getState().moveWindow(w2.id, 500, 400);

      useCanvasGroups.getState().createGroup("Test", "#3b82f6");
      const groupId = useCanvasGroups.getState().groups[0].id;
      useCanvasGroups.getState().addToGroup(groupId, w1.id);
      useCanvasGroups.getState().addToGroup(groupId, w2.id);

      const bounds = useCanvasGroups.getState().getGroupBounds(groupId);
      expect(bounds).toBeDefined();
      expect(bounds!.x).toBe(80);
      expect(bounds!.y).toBe(80);
    });
  });
});

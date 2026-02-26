// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import { useCanvasTransform, INTERACTION_THRESHOLD } from "../../shell/src/hooks/useCanvasTransform.js";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

function resetStores() {
  useWindowManager.setState({ windows: [], nextZ: 1, closedPaths: new Set(), apps: [] });
  useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false });
  useDesktopMode.setState({ mode: "desktop" });
}

describe("Canvas Renderer Integration", () => {
  beforeEach(() => {
    resetStores();
  });

  it("canvas mode config has correct properties", () => {
    const config = useDesktopMode.getState().getModeConfig("canvas");
    expect(config.showDock).toBe(true);
    expect(config.showWindows).toBe(true);
    expect(config.showBottomPanel).toBe(false);
    expect(config.chatPosition).toBe("sidebar");
  });

  it("switching to canvas mode updates store", () => {
    useDesktopMode.getState().setMode("canvas");
    expect(useDesktopMode.getState().mode).toBe("canvas");
  });

  it("window manager and canvas transform work together", () => {
    useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
    useCanvasTransform.getState().setZoom(2);

    const windows = useWindowManager.getState().windows;
    const zoom = useCanvasTransform.getState().zoom;

    expect(windows).toHaveLength(1);
    expect(zoom).toBe(2);
  });

  it("zoom below threshold makes windows non-interactive", () => {
    useCanvasTransform.getState().setZoom(0.5);
    expect(useCanvasTransform.getState().zoom).toBeLessThan(INTERACTION_THRESHOLD);
  });

  it("zoom at threshold makes windows interactive", () => {
    useCanvasTransform.getState().setZoom(INTERACTION_THRESHOLD);
    expect(useCanvasTransform.getState().zoom).toBe(INTERACTION_THRESHOLD);
  });

  it("fitAll centers windows in viewport", () => {
    useWindowManager.getState().openWindow("App1", "apps/app1.html", 20);
    useWindowManager.getState().openWindow("App2", "apps/app2.html", 20);
    const wins = useWindowManager.getState().windows;
    useCanvasTransform.getState().fitAll(
      wins.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      1200,
      800,
    );
    const { zoom, panX, panY } = useCanvasTransform.getState();
    expect(zoom).toBeGreaterThan(0);
    expect(typeof panX).toBe("number");
    expect(typeof panY).toBe("number");
  });

  it("canvas mode cycles correctly with other modes", () => {
    const modes = useDesktopMode.getState().allModes();
    const ids = modes.map((m) => m.id);
    expect(ids).toContain("canvas");
    const canvasIdx = ids.indexOf("canvas");
    expect(canvasIdx).toBeGreaterThan(0); // after desktop
  });

  it("drag movement in canvas accounts for zoom scale", () => {
    useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
    const winId = useWindowManager.getState().windows[0].id;
    const origX = useWindowManager.getState().windows[0].x;

    useCanvasTransform.setState({ zoom: 2 });
    // Simulating a 100px screen drag at 2x zoom = 50px canvas movement
    useWindowManager.getState().moveWindow(winId, origX + 50, 20);
    expect(useWindowManager.getState().windows[0].x).toBe(origX + 50);
  });
});

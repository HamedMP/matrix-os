// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useWindowManager,
  type AppWindow,
  type LayoutWindow,
} from "../../shell/src/hooks/useWindowManager.js";

const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", fetchSpy);

function resetStore() {
  useWindowManager.setState({
    windows: [],
    nextZ: 1,
    closedPaths: new Set(),
    apps: [],
  });
}

describe("Window Manager Store", () => {
  beforeEach(() => {
    resetStore();
    fetchSpy.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("openWindow", () => {
    it("creates a new window with default dimensions", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const { windows } = useWindowManager.getState();
      expect(windows).toHaveLength(1);
      expect(windows[0].title).toBe("Notes");
      expect(windows[0].path).toBe("apps/notes.html");
      expect(windows[0].width).toBe(640);
      expect(windows[0].height).toBe(480);
      expect(windows[0].minimized).toBe(false);
    });

    it("restores and focuses existing window instead of creating duplicate", () => {
      const { openWindow } = useWindowManager.getState();
      openWindow("Notes", "apps/notes.html", 80);
      useWindowManager.getState().minimizeWindow(useWindowManager.getState().windows[0].id);
      expect(useWindowManager.getState().windows[0].minimized).toBe(true);

      openWindow("Notes", "apps/notes.html", 80);
      const { windows } = useWindowManager.getState();
      expect(windows).toHaveLength(1);
      expect(windows[0].minimized).toBe(false);
    });

    it("cascades window positions based on existing window count", () => {
      const { openWindow } = useWindowManager.getState();
      openWindow("App1", "apps/app1.html", 80);
      openWindow("App2", "apps/app2.html", 80);
      const [w1, w2] = useWindowManager.getState().windows;
      expect(w2.x).toBe(w1.x + 30);
      expect(w2.y).toBe(w1.y + 30);
    });

    it("assigns incrementing zIndex", () => {
      const { openWindow } = useWindowManager.getState();
      openWindow("App1", "apps/app1.html", 80);
      openWindow("App2", "apps/app2.html", 80);
      const [w1, w2] = useWindowManager.getState().windows;
      expect(w2.zIndex).toBeGreaterThan(w1.zIndex);
    });
  });

  describe("closeWindow", () => {
    it("removes the window and tracks path as closed", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().closeWindow(winId);
      expect(useWindowManager.getState().windows).toHaveLength(0);
      expect(useWindowManager.getState().closedPaths.has("apps/notes.html")).toBe(true);
    });
  });

  describe("minimizeWindow / restoreWindow", () => {
    it("minimizes a window", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().minimizeWindow(winId);
      expect(useWindowManager.getState().windows[0].minimized).toBe(true);
    });

    it("restores a minimized window", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().minimizeWindow(winId);
      useWindowManager.getState().restoreWindow(winId);
      expect(useWindowManager.getState().windows[0].minimized).toBe(false);
    });
  });

  describe("moveWindow", () => {
    it("updates window position", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().moveWindow(winId, 200, 300);
      const win = useWindowManager.getState().windows[0];
      expect(win.x).toBe(200);
      expect(win.y).toBe(300);
    });
  });

  describe("resizeWindow", () => {
    it("updates window dimensions respecting minimums", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().resizeWindow(winId, 100, 50);
      const win = useWindowManager.getState().windows[0];
      expect(win.width).toBe(320); // MIN_WIDTH
      expect(win.height).toBe(200); // MIN_HEIGHT
    });

    it("accepts valid sizes above minimum", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().resizeWindow(winId, 800, 600);
      const win = useWindowManager.getState().windows[0];
      expect(win.width).toBe(800);
      expect(win.height).toBe(600);
    });
  });

  describe("focusWindow", () => {
    it("brings a window to the front with highest zIndex", () => {
      const { openWindow } = useWindowManager.getState();
      openWindow("App1", "apps/app1.html", 80);
      openWindow("App2", "apps/app2.html", 80);
      const w1Id = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().focusWindow(w1Id);
      const [w1, w2] = useWindowManager.getState().windows;
      expect(w1.zIndex).toBeGreaterThan(w2.zIndex);
    });
  });

  describe("getWindow", () => {
    it("returns window by id", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      const win = useWindowManager.getState().getWindow(winId);
      expect(win?.title).toBe("Notes");
    });

    it("returns undefined for unknown id", () => {
      expect(useWindowManager.getState().getWindow("nonexistent")).toBeUndefined();
    });
  });

  describe("layout persistence", () => {
    it("saves layout via PUT /api/layout after 500ms debounce", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/layout"),
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("includes closed paths in layout save", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().closeWindow(winId);
      fetchSpy.mockClear();
      vi.advanceTimersByTime(500);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.windows.some((w: LayoutWindow) => w.path === "apps/notes.html" && w.state === "closed")).toBe(true);
    });

    it("debounces rapid changes into a single save", () => {
      const { openWindow } = useWindowManager.getState();
      openWindow("App1", "apps/app1.html", 80);
      vi.advanceTimersByTime(200);
      openWindow("App2", "apps/app2.html", 80);
      vi.advanceTimersByTime(200);
      openWindow("App3", "apps/app3.html", 80);
      vi.advanceTimersByTime(500);
      // Only the final debounced call should fire
      const putCalls = fetchSpy.mock.calls.filter(
        (c: [string, RequestInit]) => c[1]?.method === "PUT",
      );
      expect(putCalls).toHaveLength(1);
    });
  });

  describe("loadLayout", () => {
    it("restores windows from saved layout", () => {
      const saved: LayoutWindow[] = [
        {
          path: "apps/notes.html",
          title: "Notes",
          x: 100, y: 100, width: 800, height: 600,
          state: "open",
        },
        {
          path: "apps/todo.html",
          title: "Todo",
          x: 200, y: 200, width: 640, height: 480,
          state: "minimized",
        },
        {
          path: "apps/closed.html",
          title: "Closed",
          x: 0, y: 0, width: 640, height: 480,
          state: "closed",
        },
      ];

      useWindowManager.getState().loadLayout(saved);
      const { windows, closedPaths } = useWindowManager.getState();
      expect(windows).toHaveLength(2);
      expect(windows.find((w) => w.path === "apps/notes.html")?.minimized).toBe(false);
      expect(windows.find((w) => w.path === "apps/todo.html")?.minimized).toBe(true);
      expect(closedPaths.has("apps/closed.html")).toBe(true);
    });
  });
});

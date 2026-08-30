// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useWindowManager,
  resetWindowManagerLayoutPersistenceForTests,
  type AppWindow,
  type LayoutWindow,
} from "../../shell/src/hooks/useWindowManager.js";
import {
  SHELL_WINDOW_Z_INDEX_MAX,
  SHELL_Z_INDEX,
} from "../../shell/src/lib/shell-layering.js";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";

const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", fetchSpy);
const defaultInnerWidth = window.innerWidth;
const defaultInnerHeight = window.innerHeight;

function resetStore() {
  resetWindowManagerLayoutPersistenceForTests();
  useDesktopMode.setState({ mode: "desktop", previousMode: null, _hydrated: true });
  useWindowManager.setState({
    windows: [],
    nextZ: 1,
    closedPaths: new Set(),
    closedLayouts: new Map(),
    focusedWindowId: null,
    fullscreenWindowId: null,
  });
}

describe("Window Manager Store", () => {
  beforeEach(() => {
    resetStore();
    window.history.pushState(null, "", "/");
    fetchSpy.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: defaultInnerWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: defaultInnerHeight });
  });

  describe("openWindow", () => {
    it("creates a new window with default dimensions", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const { windows } = useWindowManager.getState();
      expect(windows).toHaveLength(1);
      expect(windows[0].title).toBe("Notes");
      expect(windows[0].path).toBe("apps/notes.html");
      // Default size is viewport-relative: min(1200, max(320, vw*0.6)) x min(900, max(200, vh*0.7))
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      expect(windows[0].width).toBe(Math.round(Math.min(1200, Math.max(320, vw * 0.6))));
      expect(windows[0].height).toBe(Math.round(Math.min(900, Math.max(200, vh * 0.7))));
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

    it("centers every Desktop window without asymmetric cascade margins", () => {
      const { openWindow } = useWindowManager.getState();
      openWindow("App1", "apps/app1.html", 80);
      openWindow("App2", "apps/app2.html", 80);
      const [w1, w2] = useWindowManager.getState().windows;
      expect(w2.x).toBe(w1.x);
      expect(w2.y).toBe(w1.y);
      expect(w1.x).toBe(Math.round((window.innerWidth - w1.width) / 2));
      expect(w1.y).toBe(Math.max(24, Math.round((window.innerHeight - 38 - w1.height) / 2)));
    });

    it("places second canvas window to the right of the first", () => {
      useDesktopMode.getState().setMode("canvas");
      const { openWindow } = useWindowManager.getState();
      openWindow("App1", "apps/app1.html", 80);
      openWindow("App2", "apps/app2.html", 80);
      const [w1, w2] = useWindowManager.getState().windows;
      expect(w2.x).toBe(w1.x + w1.width + 24);
      expect(w2.y).toBe(w1.y);
    });

    it("fits a fresh terminal inside a narrow desktop work area", () => {
      useDesktopMode.setState({ mode: "desktop" });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });

      useWindowManager.getState().openWindow("Terminal", "__terminal__", 80);

      expect(useWindowManager.getState().windows[0]).toMatchObject({
        x: 20,
        y: 20,
        width: 860,
        height: 522,
      });
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

  describe("reconcileWindowsToViewport", () => {
    it("fits open desktop windows after the viewport shrinks", () => {
      useDesktopMode.setState({ mode: "desktop" });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
      useWindowManager.getState().loadLayout([{
        path: "__file-browser__",
        title: "Files",
        x: 500,
        y: 192,
        width: 900,
        height: 650,
        state: "open",
      }]);

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
      useWindowManager.getState().reconcileWindowsToViewport();

      expect(useWindowManager.getState().windows[0]).toMatchObject({
        x: 20,
        y: 20,
        width: 760,
        height: 422,
      });
    });

    it("shrinks below the preferred minimum when the desktop is extremely short", () => {
      useDesktopMode.setState({ mode: "desktop" });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 250 });
      useWindowManager.getState().loadLayout([{
        path: "__file-browser__",
        title: "Files",
        x: 40,
        y: 40,
        width: 600,
        height: 480,
        state: "open",
      }]);

      useWindowManager.getState().reconcileWindowsToViewport();

      const windowRecord = useWindowManager.getState().windows[0];
      expect(windowRecord).toMatchObject({
        x: 20,
        y: 20,
        width: 600,
        height: 172,
      });
      expect(windowRecord.y + 38 + windowRecord.height).toBeLessThanOrEqual(230);
    });

    it("leaves spatial Canvas windows unchanged", () => {
      useDesktopMode.setState({ mode: "canvas" });
      useWindowManager.setState({
        windows: [{
          id: "canvas-window",
          path: "apps/notes.html",
          title: "Notes",
          x: 1400,
          y: 900,
          width: 800,
          height: 600,
          minimized: false,
          zIndex: 1,
        }],
      });

      useWindowManager.getState().reconcileWindowsToViewport();

      expect(useWindowManager.getState().windows[0]).toMatchObject({
        x: 1400,
        y: 900,
        width: 800,
        height: 600,
      });
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
      expect(useWindowManager.getState().getFocusedWindow()?.id).toBe(w1Id);
    });

    it("compacts focused window z-indexes below the settings layer", () => {
      const terminal: AppWindow = {
        id: "win-terminal",
        title: "Terminal",
        path: "__terminal__",
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        minimized: false,
        zIndex: SHELL_WINDOW_Z_INDEX_MAX,
      };
      const notes: AppWindow = {
        id: "win-notes",
        title: "Notes",
        path: "apps/notes.html",
        x: 40,
        y: 40,
        width: 640,
        height: 480,
        minimized: false,
        zIndex: SHELL_WINDOW_Z_INDEX_MAX - 1,
      };
      useWindowManager.setState({
        windows: [terminal, notes],
        nextZ: SHELL_WINDOW_Z_INDEX_MAX + 1,
      });

      useWindowManager.getState().focusWindow("win-terminal");

      const { windows } = useWindowManager.getState();
      const focused = windows.find((w) => w.id === "win-terminal");
      const highestWindowZ = Math.max(...windows.map((w) => w.zIndex));
      expect(focused?.zIndex).toBe(highestWindowZ);
      expect(highestWindowZ).toBeLessThan(SHELL_Z_INDEX.settings);
    });

    it("clears focused window when clicking the canvas background", () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      expect(useWindowManager.getState().getFocusedWindow()).toBeDefined();

      useWindowManager.getState().clearFocus();

      expect(useWindowManager.getState().getFocusedWindow()).toBeUndefined();
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
    it("saves layout through the revisioned OS-view state after 500ms debounce", async () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/os-view-state"),
        expect.objectContaining({ method: "PATCH" }),
      );
    });

    it("does not save layout on the pre-VPS billing setup route", () => {
      window.history.pushState(null, "", "/?billing=setup");
      useWindowManager.getState().openWindow("Settings", "__settings__", 80);
      vi.advanceTimersByTime(500);

      expect(fetchSpy).not.toHaveBeenCalled();

      window.history.pushState(null, "", "/");
    });

    it("includes closed paths in layout save", async () => {
      useWindowManager.getState().openWindow("Notes", "apps/notes.html", 80);
      const winId = useWindowManager.getState().windows[0].id;
      useWindowManager.getState().closeWindow(winId);
      fetchSpy.mockClear();
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.patch.apps.some((app: LayoutWindow) => app.path === "apps/notes.html" && app.state === "closed")).toBe(true);
    });

    it("debounces rapid changes into a single save", async () => {
      const { openWindow } = useWindowManager.getState();
      openWindow("App1", "apps/app1.html", 80);
      vi.advanceTimersByTime(200);
      openWindow("App2", "apps/app2.html", 80);
      vi.advanceTimersByTime(200);
      openWindow("App3", "apps/app3.html", 80);
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      // Only the final debounced call should fire
      const putCalls = fetchSpy.mock.calls.filter(
        (c: [string, RequestInit]) => c[1]?.method === "PATCH",
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

    it("recenters restored wide dev-mode windows so their side margins stay symmetric", () => {
      const width = Math.round(window.innerWidth * 0.9);
      const saved: LayoutWindow[] = [
        {
          path: "__file-browser__",
          title: "Files",
          x: 85,
          y: 80,
          width,
          height: 600,
          state: "open",
        },
      ];

      useWindowManager.getState().loadLayout(saved);

      const [restored] = useWindowManager.getState().windows;
      expect(restored.x).toBe(Math.round((window.innerWidth - width) / 2));
      expect(window.innerWidth - (restored.x + restored.width)).toBe(restored.x);
      expect(restored.y).toBe(80);
    });

    it("fits restored desktop windows inside the current viewport", () => {
      useDesktopMode.setState({ mode: "desktop" });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
      const saved: LayoutWindow[] = [
        {
          path: "__file-browser__",
          title: "Files",
          x: 1_400,
          y: 900,
          width: 1_200,
          height: 900,
          state: "open",
        },
      ];

      useWindowManager.getState().loadLayout(saved);

      const [restored] = useWindowManager.getState().windows;
      expect(restored).toMatchObject({
        x: 20,
        y: 20,
        width: 860,
        height: 522,
      });
      expect(restored.x + restored.width).toBeLessThanOrEqual(window.innerWidth - 20);
      expect(restored.y + 38 + restored.height).toBeLessThanOrEqual(window.innerHeight - 20);
    });

    it("shrinks a restored terminal below its preferred minimum on narrow desktops", () => {
      useDesktopMode.setState({ mode: "desktop" });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });

      useWindowManager.getState().loadLayout([{
        path: "__terminal__",
        title: "Terminal",
        x: 200,
        y: 160,
        width: 1_040,
        height: 680,
        state: "open",
      }]);

      expect(useWindowManager.getState().windows[0]).toMatchObject({
        x: 20,
        y: 20,
        width: 860,
        height: 522,
      });
    });

    it("keeps a reopened terminal fitted to a narrow desktop", () => {
      useDesktopMode.setState({ mode: "desktop" });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });

      useWindowManager.getState().loadLayout([{
        path: "__terminal__",
        title: "Terminal",
        x: 200,
        y: 160,
        width: 1_040,
        height: 680,
        state: "closed",
      }]);
      useWindowManager.getState().openWindow("Terminal", "__terminal__", 80);

      expect(useWindowManager.getState().windows[0]).toMatchObject({
        x: 20,
        y: 20,
        width: 860,
        height: 522,
      });
    });

    it("does not save immediately while hydrating server layout", () => {
      const saved: LayoutWindow[] = [
        {
          path: "apps/notes.html",
          title: "Notes",
          x: 100, y: 100, width: 800, height: 600,
          state: "open",
        },
      ];

      useWindowManager.getState().loadLayout(saved);
      vi.advanceTimersByTime(500);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

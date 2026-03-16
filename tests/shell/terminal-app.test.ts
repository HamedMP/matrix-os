import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTerminalStore, countPanes, getAllPaneIds, getAdjacentPaneId } from "../../shell/src/stores/terminal-store.js";

vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));

describe("Terminal App integration (store-driven)", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabs: [],
      activeTabId: "",
      sidebarOpen: true,
      sidebarWidth: 200,
      sidebarSelectedPath: null,
      focusedPaneId: null,
    });
  });

  describe("Claude Code launch flow", () => {
    it("creates a tab labeled 'Claude Code' with correct cwd", () => {
      const store = useTerminalStore.getState();
      store.addTab("projects/myapp", "Claude Code");

      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].label).toBe("Claude Code");
      expect(state.tabs[0].paneTree.type).toBe("pane");
      if (state.tabs[0].paneTree.type === "pane") {
        expect(state.tabs[0].paneTree.cwd).toBe("projects/myapp");
      }
    });
  });

  describe("multi-tab workflow", () => {
    it("supports multiple tabs with different cwds", () => {
      const store = useTerminalStore.getState();
      store.addTab("projects/app1");
      store.addTab("projects/app2");
      store.addTab("projects/app3", "Claude Code");

      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(3);
      expect(state.tabs[2].label).toBe("Claude Code");
    });

    it("splits and closes panes correctly in a complex workflow", () => {
      const store = useTerminalStore.getState();
      store.addTab("projects/app");

      const tab = useTerminalStore.getState().tabs[0];
      const paneId = (tab.paneTree as { id: string }).id;

      store.splitPane(paneId, "horizontal");
      expect(countPanes(useTerminalStore.getState().tabs[0].paneTree)).toBe(2);

      const ids1 = getAllPaneIds(useTerminalStore.getState().tabs[0].paneTree);
      store.splitPane(ids1[1], "vertical");
      expect(countPanes(useTerminalStore.getState().tabs[0].paneTree)).toBe(3);

      const ids2 = getAllPaneIds(useTerminalStore.getState().tabs[0].paneTree);
      store.closePane(ids2[1]);
      expect(countPanes(useTerminalStore.getState().tabs[0].paneTree)).toBe(2);
    });
  });

  describe("sidebar interaction", () => {
    it("selecting a path in sidebar affects new tab cwd", () => {
      const store = useTerminalStore.getState();
      store.setSidebarSelectedPath("projects/myapp");

      expect(useTerminalStore.getState().sidebarSelectedPath).toBe("projects/myapp");

      store.addTab(useTerminalStore.getState().sidebarSelectedPath ?? "projects");
      const tab = useTerminalStore.getState().tabs[0];
      if (tab.paneTree.type === "pane") {
        expect(tab.paneTree.cwd).toBe("projects/myapp");
      }
    });
  });

  describe("layout persistence", () => {
    it("saveLayout calls fetch with correct data", () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn(() => Promise.resolve({ ok: true }));
      vi.stubGlobal("fetch", mockFetch);

      const store = useTerminalStore.getState();
      store.addTab("projects/app");

      vi.advanceTimersByTime(600);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/terminal/layout"),
        expect.objectContaining({ method: "PUT" }),
      );

      vi.useRealTimers();
    });
  });

  describe("pane navigation", () => {
    it("getAdjacentPaneId navigates between split panes", () => {
      const store = useTerminalStore.getState();
      store.addTab("projects/app");

      const tab = useTerminalStore.getState().tabs[0];
      const paneId = (tab.paneTree as { id: string }).id;
      store.splitPane(paneId, "horizontal");

      const updated = useTerminalStore.getState().tabs[0];
      const ids = getAllPaneIds(updated.paneTree);

      expect(getAdjacentPaneId(updated.paneTree, ids[0], 1)).toBe(ids[1]);
      expect(getAdjacentPaneId(updated.paneTree, ids[1], -1)).toBe(ids[0]);
    });
  });

  describe("tab label edge cases", () => {
    it("uses ~ for root path", () => {
      const store = useTerminalStore.getState();
      store.addTab("");
      expect(useTerminalStore.getState().tabs[0].label).toBe("~");
    });

    it("allows duplicate labels", () => {
      const store = useTerminalStore.getState();
      store.addTab("projects/app");
      store.addTab("projects/app");

      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.tabs[0].label).toBe("app");
      expect(state.tabs[1].label).toBe("app");
    });
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTerminalStore, countPanes, getAllPaneIds, getAdjacentPaneId } from "../../shell/src/stores/terminal-store.js";

vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));

describe("useTerminalStore", () => {
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

  describe("tab management", () => {
    it("adds a tab with correct defaults", () => {
      const store = useTerminalStore.getState();
      const id = store.addTab("/home/user/projects/myapp");

      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].id).toBe(id);
      expect(state.tabs[0].label).toBe("myapp");
      expect(state.activeTabId).toBe(id);
      expect(state.tabs[0].paneTree.type).toBe("pane");
    });

    it("adds a tab with custom label", () => {
      const store = useTerminalStore.getState();
      store.addTab("/home/user/projects/app", "Claude Code");

      const state = useTerminalStore.getState();
      expect(state.tabs[0].label).toBe("Claude Code");
    });

    it("closes a tab and activates the next one", () => {
      const store = useTerminalStore.getState();
      const id1 = store.addTab("/home/user/projects/a");
      const id2 = store.addTab("/home/user/projects/b");
      store.setActiveTab(id1);

      store.closeTab(id1);
      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.activeTabId).toBe(id2);
    });

    it("closes the last tab and clears activeTabId", () => {
      const store = useTerminalStore.getState();
      const id = store.addTab("/home/user");

      store.closeTab(id);
      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(0);
      expect(state.activeTabId).toBe("");
    });

    it("renames a tab", () => {
      const store = useTerminalStore.getState();
      const id = store.addTab("/home/user/projects/app");
      store.renameTab(id, "My App");

      const state = useTerminalStore.getState();
      expect(state.tabs[0].label).toBe("My App");
    });

    it("reorders tabs", () => {
      const store = useTerminalStore.getState();
      store.addTab("/a");
      store.addTab("/b");
      store.addTab("/c");

      store.reorderTabs(2, 0);
      const state = useTerminalStore.getState();
      const labels = state.tabs.map((t) => t.label);
      expect(labels).toEqual(["c", "a", "b"]);
    });

    it("sets active tab and focuses first pane", () => {
      const store = useTerminalStore.getState();
      const id1 = store.addTab("/a");
      const id2 = store.addTab("/b");

      store.setActiveTab(id1);
      const state = useTerminalStore.getState();
      expect(state.activeTabId).toBe(id1);
      expect(state.focusedPaneId).toBeTruthy();
    });
  });

  describe("pane management", () => {
    it("splits a pane horizontally", () => {
      const store = useTerminalStore.getState();
      store.addTab("/home/user");
      const tab = useTerminalStore.getState().tabs[0];
      const paneId = (tab.paneTree as { id: string }).id;

      store.splitPane(paneId, "horizontal");
      const updated = useTerminalStore.getState().tabs[0];
      expect(updated.paneTree.type).toBe("split");
      expect(countPanes(updated.paneTree)).toBe(2);
    });

    it("splits a pane vertically", () => {
      const store = useTerminalStore.getState();
      store.addTab("/home/user");
      const tab = useTerminalStore.getState().tabs[0];
      const paneId = (tab.paneTree as { id: string }).id;

      store.splitPane(paneId, "vertical");
      const updated = useTerminalStore.getState().tabs[0];
      expect(updated.paneTree.type).toBe("split");
      if (updated.paneTree.type === "split") {
        expect(updated.paneTree.direction).toBe("vertical");
      }
    });

    it("respects max 4 panes per tab", () => {
      const store = useTerminalStore.getState();
      store.addTab("/home/user");

      for (let i = 0; i < 5; i++) {
        const tab = useTerminalStore.getState().tabs[0];
        const ids = getAllPaneIds(tab.paneTree);
        store.splitPane(ids[0], "horizontal");
      }

      const final = useTerminalStore.getState().tabs[0];
      expect(countPanes(final.paneTree)).toBeLessThanOrEqual(4);
    });

    it("closes a pane in a split", () => {
      const store = useTerminalStore.getState();
      store.addTab("/home/user");
      const tab = useTerminalStore.getState().tabs[0];
      const paneId = (tab.paneTree as { id: string }).id;

      store.splitPane(paneId, "horizontal");
      const split = useTerminalStore.getState().tabs[0];
      const ids = getAllPaneIds(split.paneTree);
      expect(ids).toHaveLength(2);

      store.closePane(ids[1]);
      const after = useTerminalStore.getState().tabs[0];
      expect(countPanes(after.paneTree)).toBe(1);
    });

    it("closing last pane closes the tab", () => {
      const store = useTerminalStore.getState();
      store.addTab("/home/user");
      const tab = useTerminalStore.getState().tabs[0];
      const paneId = (tab.paneTree as { id: string }).id;

      store.closePane(paneId);
      expect(useTerminalStore.getState().tabs).toHaveLength(0);
    });
  });

  describe("sidebar", () => {
    it("toggles sidebar open state", () => {
      const store = useTerminalStore.getState();
      store.setSidebarOpen(false);
      expect(useTerminalStore.getState().sidebarOpen).toBe(false);

      store.setSidebarOpen(true);
      expect(useTerminalStore.getState().sidebarOpen).toBe(true);
    });

    it("sets sidebar width", () => {
      const store = useTerminalStore.getState();
      store.setSidebarWidth(300);
      expect(useTerminalStore.getState().sidebarWidth).toBe(300);
    });

    it("sets selected path", () => {
      const store = useTerminalStore.getState();
      store.setSidebarSelectedPath("/projects/myapp");
      expect(useTerminalStore.getState().sidebarSelectedPath).toBe("/projects/myapp");
    });
  });
});

describe("utility functions", () => {
  it("countPanes counts single pane", () => {
    expect(countPanes({ type: "pane", id: "a", cwd: "/" })).toBe(1);
  });

  it("countPanes counts split panes", () => {
    expect(countPanes({
      type: "split",
      direction: "horizontal",
      children: [
        { type: "pane", id: "a", cwd: "/" },
        { type: "pane", id: "b", cwd: "/" },
      ],
      ratio: 0.5,
    })).toBe(2);
  });

  it("getAllPaneIds returns all pane IDs", () => {
    const ids = getAllPaneIds({
      type: "split",
      direction: "horizontal",
      children: [
        { type: "pane", id: "a", cwd: "/" },
        { type: "pane", id: "b", cwd: "/" },
      ],
      ratio: 0.5,
    });
    expect(ids).toEqual(["a", "b"]);
  });

  it("getAdjacentPaneId returns next pane", () => {
    const tree = {
      type: "split" as const,
      direction: "horizontal" as const,
      children: [
        { type: "pane" as const, id: "a", cwd: "/" },
        { type: "pane" as const, id: "b", cwd: "/" },
      ] as [{ type: "pane"; id: string; cwd: string }, { type: "pane"; id: string; cwd: string }],
      ratio: 0.5,
    };
    expect(getAdjacentPaneId(tree, "a", 1)).toBe("b");
    expect(getAdjacentPaneId(tree, "b", -1)).toBe("a");
    expect(getAdjacentPaneId(tree, "b", 1)).toBeNull();
  });
});

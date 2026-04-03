import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";

export type PaneNode =
  | { type: "pane"; id: string; cwd: string; sessionId?: string; claudeMode?: boolean }
  | { type: "split"; direction: "horizontal" | "vertical"; children: [PaneNode, PaneNode]; ratio: number };

export interface TerminalTab {
  id: string;
  label: string;
  paneTree: PaneNode;
}

interface TerminalLayout {
  tabs: TerminalTab[];
  activeTabId: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

interface TerminalStore {
  tabs: TerminalTab[];
  activeTabId: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarSelectedPath: string | null;
  focusedPaneId: string | null;

  addTab: (cwd: string, label?: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, label: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;

  splitPane: (paneId: string, direction: "horizontal" | "vertical") => void;
  closePane: (paneId: string) => void;
  setFocusedPane: (paneId: string) => void;
  setSplitRatio: (paneId: string, ratio: number) => void;
  setSessionId: (paneId: string, sessionId: string) => void;

  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarSelectedPath: (path: string | null) => void;

  loadLayout: () => Promise<void>;
  saveLayout: () => void;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}

const MAX_TREE_DEPTH = 10;

function countPanes(node: PaneNode, depth = 0): number {
  if (depth > MAX_TREE_DEPTH) return 0;
  if (node.type === "pane") return 1;
  return countPanes(node.children[0], depth + 1) + countPanes(node.children[1], depth + 1);
}

function findPaneInTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  return findPaneInTree(node.children[0], paneId) ?? findPaneInTree(node.children[1], paneId);
}

function splitPaneInTree(node: PaneNode, paneId: string, direction: "horizontal" | "vertical"): PaneNode {
  if (node.type === "pane") {
    if (node.id === paneId) {
      return {
        type: "split",
        direction,
        children: [
          node,
          { type: "pane", id: generateId(), cwd: node.cwd },
        ],
        ratio: 0.5,
      };
    }
    return node;
  }
  return {
    ...node,
    children: [
      splitPaneInTree(node.children[0], paneId, direction),
      splitPaneInTree(node.children[1], paneId, direction),
    ],
  };
}

function closePaneInTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "pane") {
    return node.id === paneId ? null : node;
  }

  const left = node.children[0];
  const right = node.children[1];

  if (left.type === "pane" && left.id === paneId) return right;
  if (right.type === "pane" && right.id === paneId) return left;

  const newLeft = closePaneInTree(left, paneId);
  const newRight = closePaneInTree(right, paneId);

  if (!newLeft) return newRight;
  if (!newRight) return newLeft;

  return { ...node, children: [newLeft, newRight] };
}

function setSplitRatioInTree(node: PaneNode, paneId: string, ratio: number): PaneNode {
  if (node.type === "pane") return node;

  const leftContains = findPaneInTree(node.children[0], paneId);
  const rightContains = findPaneInTree(node.children[1], paneId);

  if (leftContains || rightContains) {
    if (leftContains && !rightContains) {
      return { ...node, ratio, children: [setSplitRatioInTree(node.children[0], paneId, ratio), node.children[1]] };
    }
    if (rightContains && !leftContains) {
      return { ...node, ratio, children: [node.children[0], setSplitRatioInTree(node.children[1], paneId, ratio)] };
    }
    return { ...node, ratio };
  }
  return node;
}

function getFirstPaneId(node: PaneNode): string {
  if (node.type === "pane") return node.id;
  return getFirstPaneId(node.children[0]);
}

function getAllPaneIds(node: PaneNode): string[] {
  if (node.type === "pane") return [node.id];
  return [...getAllPaneIds(node.children[0]), ...getAllPaneIds(node.children[1])];
}

function getAdjacentPaneId(node: PaneNode, paneId: string, direction: 1 | -1): string | null {
  const ids = getAllPaneIds(node);
  const idx = ids.indexOf(paneId);
  if (idx === -1) return null;
  const next = idx + direction;
  if (next < 0 || next >= ids.length) return null;
  return ids[next];
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  tabs: [],
  activeTabId: "",
  sidebarOpen: true,
  sidebarWidth: 200,
  sidebarSelectedPath: null,
  focusedPaneId: null,

  addTab: (cwd, label) => {
    const id = generateId();
    const paneId = generateId();
    const basename = cwd.split("/").filter(Boolean).pop() ?? "~";
    const tab: TerminalTab = {
      id,
      label: label ?? basename,
      paneTree: { type: "pane", id: paneId, cwd },
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      focusedPaneId: paneId,
    }));
    get().saveLayout();
    return id;
  },

  closeTab: (tabId) => {
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== tabId);
      let activeTabId = state.activeTabId;
      if (activeTabId === tabId) {
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        activeTabId = newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? "";
      }
      return { tabs: newTabs, activeTabId };
    });
    get().saveLayout();
  },

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    set({
      activeTabId: tabId,
      focusedPaneId: tab ? getFirstPaneId(tab.paneTree) : null,
    });
  },

  renameTab: (tabId, label) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, label } : t)),
    }));
    get().saveLayout();
  },

  reorderTabs: (fromIndex, toIndex) => {
    set((state) => {
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      return { tabs };
    });
    get().saveLayout();
  },

  splitPane: (paneId, direction) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!tab || countPanes(tab.paneTree) >= 4) return state;

      return {
        tabs: state.tabs.map((t) =>
          t.id === state.activeTabId
            ? { ...t, paneTree: splitPaneInTree(t.paneTree, paneId, direction) }
            : t,
        ),
      };
    });
    get().saveLayout();
  },

  closePane: (paneId) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!tab) return state;

      const newTree = closePaneInTree(tab.paneTree, paneId);

      if (!newTree) {
        return {
          tabs: state.tabs.filter((t) => t.id !== state.activeTabId),
          activeTabId: state.tabs.find((t) => t.id !== state.activeTabId)?.id ?? "",
          focusedPaneId: null,
        };
      }

      return {
        tabs: state.tabs.map((t) =>
          t.id === state.activeTabId ? { ...t, paneTree: newTree } : t,
        ),
        focusedPaneId: getFirstPaneId(newTree),
      };
    });
    get().saveLayout();
  },

  setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

  setSplitRatio: (paneId, ratio) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === state.activeTabId
          ? { ...t, paneTree: setSplitRatioInTree(t.paneTree, paneId, ratio) }
          : t,
      ),
    }));
    get().saveLayout();
  },

  setSessionId: (paneId, sessionId) => {
    function setSessionIdInTree(node: PaneNode): PaneNode {
      if (node.type === "pane") {
        return node.id === paneId ? { ...node, sessionId } : node;
      }
      return { ...node, children: [setSessionIdInTree(node.children[0]), setSessionIdInTree(node.children[1])] };
    }

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === state.activeTabId
          ? { ...t, paneTree: setSessionIdInTree(t.paneTree) }
          : t,
      ),
    }));
    get().saveLayout();
  },

  setSidebarOpen: (open) => {
    set({ sidebarOpen: open });
    get().saveLayout();
  },
  setSidebarWidth: (width) => {
    set({ sidebarWidth: width });
    get().saveLayout();
  },
  setSidebarSelectedPath: (path) => set({ sidebarSelectedPath: path }),

  loadLayout: async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/layout`);
      if (!res.ok) return;
      const data = (await res.json()) as Partial<TerminalLayout>;
      if (data.tabs && data.tabs.length > 0) {
        set({
          tabs: data.tabs,
          activeTabId: data.activeTabId ?? data.tabs[0].id,
          sidebarOpen: data.sidebarOpen ?? true,
          sidebarWidth: data.sidebarWidth ?? 200,
        });
      }
    } catch {
      // fresh start
    }
  },

  saveLayout: () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      const { tabs, activeTabId, sidebarOpen, sidebarWidth } = get();
      const layout: TerminalLayout = { tabs, activeTabId, sidebarOpen, sidebarWidth };
      fetch(`${getGatewayUrl()}/api/terminal/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      }).catch(() => {});
    }, 500);
  },
}));

export { getAdjacentPaneId, countPanes, getAllPaneIds };

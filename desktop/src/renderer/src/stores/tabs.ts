// Tab workspace: terminals, tasks, boards, and agent threads open as tabs that
// stay mounted (cached) while inactive, so switching never tears down a running
// terminal or loses editor state. Identity-keyed open() focuses an existing tab
// instead of duplicating it.
import { create } from "zustand";

export type TabKind =
  | "home"
  | "chat"
  | "project"
  | "task"
  | "terminal"
  | "terminals"
  | "files"
  | "apps"
  | "app"
  | "plugins"
  | "settings";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  icon?: string;
  // Identity payload — at most one tab per (kind + key).
  projectSlug?: string;
  taskId?: string;
  sessionName?: string;
  slug?: string;
  closable: boolean;
}

export type RecentViewKind = "conversation" | "terminal" | "project";
export type RecentViewFilter = "all" | RecentViewKind;
export type RecentConversationType = "hermes" | "coding-agent";

export interface RecentView {
  kind: RecentViewKind;
  id: string;
  label: string;
  visitedAt: number;
  conversationType?: RecentConversationType;
}

export interface TerminalSessionRequest {
  sessionName: string;
  requestId: number;
}

export const FILES_WORKSPACE_TAB_SPEC = {
  kind: "files" as const,
  title: "Files",
  slug: "files",
  closable: false,
};

const MAX_TABS = 24;
const MAX_VIEW_HISTORY = 40;
const MAX_RECENT_VIEWS = 12;

function identityKey(
  spec: Pick<Tab, "kind" | "projectSlug" | "taskId" | "sessionName" | "slug">,
): string {
  return [
    spec.kind,
    spec.projectSlug ?? "",
    spec.taskId ?? "",
    spec.sessionName ?? "",
    spec.slug ?? "",
  ].join("|");
}

function historyPatch(viewHistory: string[], historyIndex: number) {
  return {
    viewHistory,
    historyIndex,
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex >= 0 && historyIndex < viewHistory.length - 1,
  };
}

function recordHistory(viewHistory: string[], historyIndex: number, tabId: string) {
  if (viewHistory[historyIndex] === tabId) return historyPatch(viewHistory, historyIndex);
  const branched = viewHistory.slice(0, historyIndex + 1);
  branched.push(tabId);
  const bounded = branched.slice(-MAX_VIEW_HISTORY);
  return historyPatch(bounded, bounded.length - 1);
}

function pruneHistory(
  viewHistory: string[],
  historyIndex: number,
  removedIds: Readonly<Record<string, true>>,
) {
  const removedBeforeOrAt = viewHistory
    .slice(0, historyIndex + 1)
    .filter((id) => removedIds[id]).length;
  const next = viewHistory.filter((id) => !removedIds[id]);
  const nextIndex = Math.min(next.length - 1, Math.max(-1, historyIndex - removedBeforeOrAt));
  return historyPatch(next, nextIndex);
}

function recordRecent(recentViews: RecentView[], recent: RecentView | null): RecentView[] {
  if (!recent) return recentViews;
  return [
    recent,
    ...recentViews.filter((item) => item.kind !== recent.kind || item.id !== recent.id),
  ].slice(0, MAX_RECENT_VIEWS);
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  navigationScope: string | null;
  viewHistory: string[];
  historyIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
  recentViews: RecentView[];
  recentFilter: RecentViewFilter;
  terminalSessionRequest: TerminalSessionRequest | null;
  terminalSessionRequestSequence: number;
  openTab(spec: Omit<Tab, "id" | "closable"> & { closable?: boolean }): string;
  closeTab(id: string): void;
  closeProjectTabs(projectSlug: string): void;
  focusTab(id: string): void;
  goBack(): void;
  goForward(): void;
  ensureNavigationScope(scope: string): void;
  recordRecentProject(id: string, label: string): void;
  recordRecentConversation(id: string, label: string): void;
  recordRecentHermesConversation(id: string, label: string): void;
  recordRecentTerminal(id: string, label: string): void;
  removeRecentView(kind: RecentViewKind, id: string): void;
  reconcileRecentHermesConversations(ids: string[]): void;
  reconcileRecentTerminals(ids: string[]): void;
  requestTerminalSession(sessionName: string): void;
  consumeTerminalSessionRequest(requestId: number): void;
  setRecentFilter(filter: RecentViewFilter): void;
  renameTab(id: string, title: string): void;
  renameTerminalSession(fromName: string, toName: string): void;
}

let counter = 0;

export const useTabs = create<TabsState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  navigationScope: null,
  viewHistory: [],
  historyIndex: -1,
  canGoBack: false,
  canGoForward: false,
  recentViews: [],
  recentFilter: "all",
  terminalSessionRequest: null,
  terminalSessionRequestSequence: 0,

  openTab: (spec) => {
    const key = identityKey(spec);
    const existing = get().tabs.find((t) => identityKey(t) === key);
    if (existing) {
      set((state) => ({
        activeTabId: existing.id,
        ...recordHistory(state.viewHistory, state.historyIndex, existing.id),
      }));
      return existing.id;
    }
    counter += 1;
    const id = `tab-${counter}`;
    const tab: Tab = { ...spec, id, closable: spec.closable ?? true };
    set((state) => {
      // Evict the oldest closable, non-active tab when over the cap.
      let tabs = [...state.tabs, tab];
      if (tabs.length > MAX_TABS) {
        const victim = tabs.find((t) => t.closable && t.id !== id && t.id !== state.activeTabId);
        if (victim) tabs = tabs.filter((t) => t.id !== victim.id);
      }
      const retainedTabIds = Object.fromEntries(tabs.map((candidate) => [candidate.id, true]));
      const victimIds: Record<string, true> = {};
      for (const existingTab of state.tabs) {
        if (!retainedTabIds[existingTab.id]) victimIds[existingTab.id] = true;
      }
      const pruned = Object.keys(victimIds).length > 0
        ? pruneHistory(state.viewHistory, state.historyIndex, victimIds)
        : historyPatch(state.viewHistory, state.historyIndex);
      return {
        tabs,
        activeTabId: id,
        ...recordHistory(pruned.viewHistory, pruned.historyIndex, id),
      };
    });
    return id;
  },

  closeTab: (id) =>
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return state;
      if (!state.tabs[idx]!.closable) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        // Focus the left neighbour; if the closed tab was first, prefer the new first.
        const next = tabs[idx - 1] ?? tabs[idx] ?? tabs[tabs.length - 1] ?? null;
        activeTabId = next?.id ?? null;
      }
      const pruned = pruneHistory(state.viewHistory, state.historyIndex, { [id]: true });
      const navigation = activeTabId
        ? recordHistory(pruned.viewHistory, pruned.historyIndex, activeTabId)
        : pruned;
      return { tabs, activeTabId, ...navigation };
    }),

  closeProjectTabs: (projectSlug) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.projectSlug !== projectSlug);
      if (tabs.length === state.tabs.length) return state;
      const home = tabs.find((tab) => tab.kind === "home");
      const activeTabId = home?.id ?? tabs[0]?.id ?? null;
      const removedIds: Record<string, true> = {};
      for (const tab of state.tabs) {
        if (tab.projectSlug === projectSlug) removedIds[tab.id] = true;
      }
      const pruned = pruneHistory(state.viewHistory, state.historyIndex, removedIds);
      const navigation = activeTabId
        ? recordHistory(pruned.viewHistory, pruned.historyIndex, activeTabId)
        : pruned;
      return { tabs, activeTabId, ...navigation };
    }),

  focusTab: (id) => set((state) => {
    const tab = state.tabs.find((candidate) => candidate.id === id);
    if (!tab) return state;
    return {
      activeTabId: id,
      ...recordHistory(state.viewHistory, state.historyIndex, id),
    };
  }),

  goBack: () => set((state) => {
    if (state.historyIndex <= 0) return state;
    const historyIndex = state.historyIndex - 1;
    return {
      activeTabId: state.viewHistory[historyIndex] ?? state.activeTabId,
      ...historyPatch(state.viewHistory, historyIndex),
    };
  }),

  goForward: () => set((state) => {
    if (state.historyIndex < 0 || state.historyIndex >= state.viewHistory.length - 1) return state;
    const historyIndex = state.historyIndex + 1;
    return {
      activeTabId: state.viewHistory[historyIndex] ?? state.activeTabId,
      ...historyPatch(state.viewHistory, historyIndex),
    };
  }),

  ensureNavigationScope: (scope) => set((state) => {
    if (state.navigationScope === scope) return state;
    // Runtime transitions replace the workspace with a single Home tab before
    // the new connection identity arrives. Seed that safe root, but never carry
    // resource tabs from a previous auth/runtime scope into navigation history.
    const soleHome = state.tabs.length === 1 && state.tabs[0]?.kind === "home"
      ? state.tabs[0]
      : null;
    return {
      navigationScope: scope,
      ...historyPatch(soleHome ? [soleHome.id] : [], soleHome ? 0 : -1),
      recentViews: [],
      recentFilter: "all",
      terminalSessionRequest: null,
      terminalSessionRequestSequence: 0,
    };
  }),

  recordRecentProject: (id, label) => set((state) => ({
    recentViews: recordRecent(state.recentViews, {
      kind: "project",
      id,
      label,
      visitedAt: Date.now(),
    }),
  })),

  recordRecentConversation: (id, label) => set((state) => ({
    recentViews: recordRecent(state.recentViews, {
      kind: "conversation",
      id,
      label,
      visitedAt: Date.now(),
      conversationType: "coding-agent",
    }),
  })),

  recordRecentHermesConversation: (id, label) => set((state) => ({
    recentViews: recordRecent(state.recentViews, {
      kind: "conversation",
      id,
      label,
      visitedAt: Date.now(),
      conversationType: "hermes",
    }),
  })),

  recordRecentTerminal: (id, label) => set((state) => ({
    recentViews: recordRecent(state.recentViews, {
      kind: "terminal",
      id,
      label,
      visitedAt: Date.now(),
    }),
  })),

  removeRecentView: (kind, id) => set((state) => ({
    recentViews: state.recentViews.filter((recent) => recent.kind !== kind || recent.id !== id),
  })),

  reconcileRecentHermesConversations: (ids) => set((state) => {
    const authoritativeIds = new Set(ids);
    return {
      recentViews: state.recentViews.filter((recent) =>
        recent.kind !== "conversation"
        || recent.conversationType === "coding-agent"
        || authoritativeIds.has(recent.id),
      ),
    };
  }),

  reconcileRecentTerminals: (ids) => set((state) => {
    const authoritativeIds = new Set(ids);
    return {
      recentViews: state.recentViews.filter((recent) =>
        recent.kind !== "terminal" || authoritativeIds.has(recent.id),
      ),
    };
  }),

  requestTerminalSession: (sessionName) => set((state) => {
    const requestId = state.terminalSessionRequestSequence + 1;
    return {
      terminalSessionRequest: { sessionName, requestId },
      terminalSessionRequestSequence: requestId,
    };
  }),

  consumeTerminalSessionRequest: (requestId) => set((state) => (
    state.terminalSessionRequest?.requestId === requestId
      ? { terminalSessionRequest: null }
      : state
  )),

  setRecentFilter: (recentFilter) => set({ recentFilter }),

  renameTab: (id, title) =>
    set((state) => ({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

  renameTerminalSession: (fromName, toName) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.kind === "terminal" && tab.sessionName === fromName
          ? { ...tab, sessionName: toName, title: toName }
          : tab,
      ),
      recentViews: state.recentViews.map((recent) =>
        recent.kind === "terminal" && recent.id === fromName
          ? { ...recent, id: toName, label: toName }
          : recent,
      ),
      terminalSessionRequest: state.terminalSessionRequest?.sessionName === fromName
        ? { ...state.terminalSessionRequest, sessionName: toName }
        : state.terminalSessionRequest,
    })),
}));

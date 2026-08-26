// Tab workspace: terminals, tasks, boards, and agent threads open as tabs that
// stay mounted (cached) while inactive, so switching never tears down a running
// terminal or loses editor state. Identity-keyed open() focuses an existing tab
// instead of duplicating it.
import { create } from "zustand";

export type TabKind =
  | "home"
  | "chat"
  | "projects"
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
  chatId?: string;
  chatView?: "index" | "draft" | "conversation";
  taskId?: string;
  sessionName?: string;
  slug?: string;
  appIdentity?: string;
  closable: boolean;
}

export type RecentViewKind = "conversation" | "terminal" | "project";
export type RecentViewFilter = "all" | RecentViewKind;
export type RecentConversationType = "hermes" | "coding-agent" | "canonical";

export interface RecentView {
  kind: RecentViewKind;
  id: string;
  label: string;
  visitedAt: number;
  conversationType?: RecentConversationType;
  projectId?: string | null;
}

export interface TerminalSessionRequest {
  sessionName: string | null;
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
  openTabAtHistoryRoot(
    spec: Omit<Tab, "id" | "closable"> & { closable?: boolean },
    detailKinds: readonly TabKind[],
  ): string;
  closeTab(id: string): void;
  closeProjectTabs(projectSlug: string): void;
  focusTab(id: string): void;
  goBack(): void;
  goForward(): void;
  ensureNavigationScope(scope: string): void;
  recordRecentProject(id: string, label: string): void;
  recordRecentConversation(id: string, label: string): void;
  recordRecentCanonicalChat(id: string, label: string, projectId: string | null): void;
  recordRecentHermesConversation(id: string, label: string): void;
  recordRecentTerminal(id: string, label: string): void;
  removeRecentView(kind: RecentViewKind, id: string): void;
  reconcileRecentHermesConversations(ids: string[]): void;
  reconcileRecentTerminals(ids: string[]): void;
  reconcileTerminalSessions(liveSessionNames: string[]): void;
  requestTerminalSession(sessionName: string): void;
  requestTerminalOverview(): void;
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
      set((state) => {
        const routeOwnsChatSelection = spec.kind === "chat" || spec.kind === "project";
        const nextChatId = routeOwnsChatSelection || spec.chatId !== undefined
          ? spec.chatId
          : existing.chatId;
        const nextChatView = spec.kind === "chat"
          ? spec.chatView ?? (nextChatId ? "conversation" : "index")
          : existing.chatView;
        const tabs = existing.title === spec.title
          && existing.chatId === nextChatId
          && existing.chatView === nextChatView
          ? state.tabs
          : state.tabs.map((tab) => tab.id === existing.id
            ? { ...tab, title: spec.title, chatId: nextChatId, chatView: nextChatView }
            : tab);
        return {
          tabs,
          activeTabId: existing.id,
          ...recordHistory(state.viewHistory, state.historyIndex, existing.id),
        };
      });
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

  openTabAtHistoryRoot: (spec, detailKinds) => {
    const previousState = get();
    const id = previousState.openTab(spec);
    set((state) => {
      const retainedTabIds = new Set(state.tabs.map((tab) => tab.id));
      const priorHistory = previousState.viewHistory
        .slice(0, previousState.historyIndex + 1)
        .filter((tabId) => retainedTabIds.has(tabId));
      const isDetailTab = (tabId: string) => {
        const tabKind = state.tabs.find((tab) => tab.id === tabId)?.kind;
        return tabKind !== undefined && detailKinds.includes(tabKind);
      };
      const nextHistory = [
        ...priorHistory.filter((tabId) => tabId !== id && !isDetailTab(tabId)),
        id,
      ].slice(-MAX_VIEW_HISTORY);
      return {
        activeTabId: id,
        ...historyPatch(nextHistory, nextHistory.length - 1),
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

  recordRecentCanonicalChat: (id, label, projectId) => set((state) => ({
    recentViews: recordRecent(state.recentViews, {
      kind: "conversation",
      id,
      label,
      visitedAt: Date.now(),
      conversationType: "canonical",
      projectId,
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
        || recent.conversationType === "canonical"
        || authoritativeIds.has(recent.id),
      ),
    };
  }),

  reconcileRecentTerminals: (ids) => set((state) => {
    const authoritativeIds = new Set(ids);
    const hasStaleRecent = state.recentViews.some((recent) =>
      recent.kind === "terminal" && !authoritativeIds.has(recent.id),
    );
    if (!hasStaleRecent) return state;
    return {
      recentViews: state.recentViews.filter((recent) =>
        recent.kind !== "terminal" || authoritativeIds.has(recent.id),
      ),
    };
  }),

  reconcileTerminalSessions: (liveSessionNames) => set((state) => {
    const liveNames = new Set(liveSessionNames);
    const removedIds: Record<string, true> = {};
    for (const tab of state.tabs) {
      if (tab.kind === "terminal" && (!tab.sessionName || !liveNames.has(tab.sessionName))) {
        removedIds[tab.id] = true;
      }
    }

    const hasRemovedTabs = Object.keys(removedIds).length > 0;
    const tabs = hasRemovedTabs
      ? state.tabs.filter((tab) => !removedIds[tab.id])
      : state.tabs;
    let activeTabId = state.activeTabId;
    if (activeTabId && removedIds[activeTabId]) {
      const activeIndex = state.tabs.findIndex((tab) => tab.id === activeTabId);
      const left = state.tabs
        .slice(0, Math.max(0, activeIndex))
        .reverse()
        .find((tab) => !removedIds[tab.id]);
      const right = state.tabs
        .slice(Math.max(0, activeIndex + 1))
        .find((tab) => !removedIds[tab.id]);
      activeTabId = left?.id ?? right?.id ?? null;
    }

    const hasStaleRecent = state.recentViews.some((recent) =>
      recent.kind === "terminal" && !liveNames.has(recent.id),
    );
    const recentViews = hasStaleRecent
      ? state.recentViews.filter((recent) => recent.kind !== "terminal" || liveNames.has(recent.id))
      : state.recentViews;
    const terminalSessionRequest = state.terminalSessionRequest
      && state.terminalSessionRequest.sessionName !== null
      && !liveNames.has(state.terminalSessionRequest.sessionName)
      ? null
      : state.terminalSessionRequest;
    if (!hasRemovedTabs && !hasStaleRecent && terminalSessionRequest === state.terminalSessionRequest) {
      return state;
    }

    const pruned = hasRemovedTabs
      ? pruneHistory(state.viewHistory, state.historyIndex, removedIds)
      : historyPatch(state.viewHistory, state.historyIndex);
    const navigation = activeTabId
      ? recordHistory(pruned.viewHistory, pruned.historyIndex, activeTabId)
      : pruned;

    return {
      tabs,
      activeTabId,
      ...navigation,
      recentViews,
      terminalSessionRequest,
    };
  }),

  requestTerminalSession: (sessionName) => set((state) => {
    const requestId = state.terminalSessionRequestSequence + 1;
    return {
      terminalSessionRequest: { sessionName, requestId },
      terminalSessionRequestSequence: requestId,
    };
  }),

  requestTerminalOverview: () => set((state) => {
    const requestId = state.terminalSessionRequestSequence + 1;
    return {
      terminalSessionRequest: { sessionName: null, requestId },
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

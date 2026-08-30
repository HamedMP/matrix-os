// Tab workspace: terminals, tasks, projects, and agent threads open as tabs that
// stay mounted (cached) while inactive, so switching never tears down a running
// terminal or loses editor state. Identity-keyed openTab() focuses an existing
// tab; openTabInstance() is the explicit user gesture for a separate top-level
// app tab with independent mounted UI state.
import { create } from "zustand";

export type TabKind =
  | "home"
  | "browser"
  | "work"
  | "chat"
  | "projects"
  | "project"
  | "task"
  | "terminal"
  | "terminals"
  | "files"
  | "editor"
  | "vscode"
  | "notes"
  | "apps"
  | "app"
  | "settings";

export type WorkRoute = "chat" | "projects" | "project";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  icon?: string;
  // Identity payload — at most one tab per (kind + key).
  projectSlug?: string;
  chatId?: string;
  chatTitle?: string;
  chatView?: "index" | "draft" | "conversation";
  workRoute?: WorkRoute;
  taskId?: string;
  sessionName?: string;
  slug?: string;
  appIdentity?: string;
  closable: boolean;
}

export function isWorkRoute(tab: Tab | undefined, route: WorkRoute): boolean {
  if (!tab) return false;
  if (tab.kind === "work") return tab.workRoute === route;
  return tab.kind === route;
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

function identityKey(
  spec: Pick<Tab, "kind" | "projectSlug" | "taskId" | "sessionName" | "slug">,
): string {
  if (spec.kind === "work") return "work";
  return [
    spec.kind,
    spec.projectSlug ?? "",
    spec.taskId ?? "",
    spec.sessionName ?? "",
    spec.slug ?? "",
  ].join("|");
}

type TabSpec = Omit<Tab, "id" | "closable"> & { closable?: boolean };

function isWorkRouteKind(kind: TabKind): kind is "work" | "chat" | "projects" | "project" {
  return kind === "work" || kind === "chat" || kind === "projects" || kind === "project";
}

function normalizeWorkTabSpec(spec: TabSpec): TabSpec {
  if (!isWorkRouteKind(spec.kind)) return spec;
  const workRoute: WorkRoute = spec.kind === "work" ? spec.workRoute ?? "chat" : spec.kind;
  const chatTitle = workRoute !== "projects" && spec.chatId
    ? spec.chatTitle ?? (spec.kind === "chat" ? spec.title : undefined)
    : undefined;
  return {
    ...spec,
    kind: "work",
    title: "Chat",
    closable: false,
    workRoute,
    chatTitle,
    ...(workRoute === "project" ? {} : { projectSlug: undefined }),
    ...(workRoute === "projects" ? { chatId: undefined, chatView: undefined } : {}),
  };
}

function normalizeRestoredTabs(tabs: Tab[], activeTabId: string | null) {
  const legacyWorkTabs = tabs.filter((tab) => (
    isWorkRouteKind(tab.kind) && !(tab.kind === "chat" && tab.closable)
  ));
  if (legacyWorkTabs.length === 0) return null;
  const retained = legacyWorkTabs.find((tab) => tab.id === activeTabId) ?? legacyWorkTabs.at(-1)!;
  if (
    legacyWorkTabs.length === 1
    && retained.kind === "work"
    && (retained.title === "Work" || retained.title === "Chat")
    && retained.closable === false
    && retained.workRoute !== undefined
  ) return null;
  const normalizedTab: Tab = {
    ...normalizeWorkTabSpec(retained),
    id: retained.id,
    closable: false,
  };
  const removedIds = new Set(legacyWorkTabs.map((tab) => tab.id));
  const nextTabs = tabs.flatMap((tab) => {
    if (!removedIds.has(tab.id)) return [tab];
    return tab.id === retained.id ? [normalizedTab] : [];
  });
  return { nextTabs, retainedId: retained.id, removedIds };
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  navigationScope: string | null;
  terminalSessionRequest: TerminalSessionRequest | null;
  terminalSessionRequestSequence: number;
  openTab(spec: Omit<Tab, "id" | "closable"> & { closable?: boolean }): string;
  openTabInstance(spec: Omit<Tab, "id" | "closable"> & { closable?: boolean }): string;
  normalizeLegacyTabs(): void;
  updateChatRoute(
    id: string,
    route: { chatId?: string; chatView: "index" | "draft" | "conversation"; title: string },
  ): void;
  clearActiveTab(id: string): void;
  closeTab(id: string): void;
  closeProjectTabs(projectSlug: string): void;
  focusTab(id: string): void;
  ensureNavigationScope(scope: string): void;
  reconcileTerminalSessions(liveSessionNames: string[]): void;
  requestTerminalSession(sessionName: string): void;
  requestTerminalOverview(): void;
  consumeTerminalSessionRequest(requestId: number): void;
  renameTab(id: string, title: string): void;
}

function appendNewTab(state: TabsState, tab: Tab): Partial<TabsState> {
  let tabs = [...state.tabs, tab];
  if (tabs.length > MAX_TABS) {
    const victim = tabs.find((candidate) => (
      candidate.closable && candidate.id !== tab.id && candidate.id !== state.activeTabId
    ));
    if (victim) tabs = tabs.filter((candidate) => candidate.id !== victim.id);
  }
  return {
    tabs,
    activeTabId: tab.id,
  };
}

let counter = 0;

export const useTabs = create<TabsState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  navigationScope: null,
  terminalSessionRequest: null,
  terminalSessionRequestSequence: 0,

  openTab: (spec) => {
    get().normalizeLegacyTabs();
    const normalizedSpec = normalizeWorkTabSpec(spec);
    const key = identityKey(normalizedSpec);
    const existing = get().tabs.find((t) => identityKey(t) === key);
    if (existing) {
      set((state) => {
        const routeOwnsChatSelection = normalizedSpec.kind === "work"
          || normalizedSpec.kind === "chat"
          || normalizedSpec.kind === "project";
        const nextChatId = routeOwnsChatSelection || normalizedSpec.chatId !== undefined
          ? normalizedSpec.chatId
          : existing.chatId;
        const nextChatView = normalizedSpec.kind === "work"
          ? normalizedSpec.workRoute === "chat"
            ? normalizedSpec.chatView ?? (nextChatId ? "conversation" : "index")
            : normalizedSpec.chatView
          : existing.chatView;
        const nextChatTitle = nextChatId ? normalizedSpec.chatTitle : undefined;
        const tabs = existing.title === normalizedSpec.title
          && existing.chatId === nextChatId
          && existing.chatTitle === nextChatTitle
          && existing.chatView === nextChatView
          && existing.projectSlug === normalizedSpec.projectSlug
          && existing.workRoute === normalizedSpec.workRoute
          ? state.tabs
          : state.tabs.map((tab) => tab.id === existing.id
            ? {
                ...tab,
                title: normalizedSpec.title,
                projectSlug: normalizedSpec.projectSlug,
                chatId: nextChatId,
                chatTitle: nextChatTitle,
                chatView: nextChatView,
                workRoute: normalizedSpec.workRoute,
              }
            : tab);
        return {
          tabs,
          activeTabId: existing.id,
        };
      });
      return existing.id;
    }
    counter += 1;
    const id = `tab-${counter}`;
    const tab: Tab = { ...normalizedSpec, id, closable: normalizedSpec.closable ?? true };
    set((state) => appendNewTab(state, tab));
    return id;
  },

  openTabInstance: (spec) => {
    counter += 1;
    const id = `tab-${counter}`;
    const tab: Tab = { ...spec, id, closable: spec.closable ?? true };
    set((state) => appendNewTab(state, tab));
    return id;
  },

  normalizeLegacyTabs: () => set((state) => {
    const normalized = normalizeRestoredTabs(state.tabs, state.activeTabId);
    if (!normalized) return state;
    const activeTabId = normalized.removedIds.has(state.activeTabId ?? "")
      ? normalized.retainedId
      : state.activeTabId;
    return {
      tabs: normalized.nextTabs,
      activeTabId,
    };
  }),

  updateChatRoute: (id, route) => set((state) => ({
    tabs: state.tabs.map((tab) => tab.id === id && tab.kind === "chat"
      ? {
          ...tab,
          title: route.title,
          chatId: route.chatId,
          chatView: route.chatView,
        }
      : tab),
  })),

  clearActiveTab: (id) => set((state) => (
    state.activeTabId === id ? { activeTabId: null } : state
  )),

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
      return { tabs, activeTabId };
    }),

  closeProjectTabs: (projectSlug) =>
    set((state) => {
      const projectTabs = state.tabs.filter((tab) => tab.projectSlug === projectSlug);
      if (projectTabs.length === 0) return state;
      const retainedWorkId = projectTabs.find((tab) => tab.kind === "work")?.id;
      const tabs = state.tabs.flatMap((tab) => {
        if (tab.projectSlug !== projectSlug) return [tab];
        if (tab.id !== retainedWorkId) return [];
        return [{
          ...tab,
          title: "Chat",
          workRoute: "chat" as const,
          projectSlug: undefined,
          chatId: undefined,
          chatTitle: undefined,
          chatView: "draft" as const,
          closable: false,
        }];
      });
      const home = tabs.find((tab) => tab.kind === "home");
      const activeTabId = state.activeTabId === retainedWorkId
        ? retainedWorkId
        : home?.id ?? tabs[0]?.id ?? null;
      return { tabs, activeTabId };
    }),

  focusTab: (id) => set((state) => {
    const tab = state.tabs.find((candidate) => candidate.id === id);
    if (!tab) return state;
    return {
      activeTabId: id,
    };
  }),

  ensureNavigationScope: (scope) => set((state) => {
    if (state.navigationScope === scope) return state;
    return {
      navigationScope: scope,
      terminalSessionRequest: null,
      terminalSessionRequestSequence: 0,
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

    const terminalSessionRequest = state.terminalSessionRequest
      && state.terminalSessionRequest.sessionName !== null
      && !liveNames.has(state.terminalSessionRequest.sessionName)
      ? null
      : state.terminalSessionRequest;
    if (!hasRemovedTabs && terminalSessionRequest === state.terminalSessionRequest) {
      return state;
    }

    return {
      tabs,
      activeTabId,
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

  renameTab: (id, title) =>
    set((state) => ({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),
}));

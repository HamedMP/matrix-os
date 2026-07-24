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
  return [
    spec.kind,
    spec.projectSlug ?? "",
    spec.taskId ?? "",
    spec.sessionName ?? "",
    spec.slug ?? "",
  ].join("|");
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  openTab(spec: Omit<Tab, "id" | "closable"> & { closable?: boolean }): string;
  closeTab(id: string): void;
  focusTab(id: string): void;
  renameTab(id: string, title: string): void;
  renameTerminalSession(fromName: string, toName: string): void;
}

let counter = 0;

export const useTabs = create<TabsState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (spec) => {
    const key = identityKey(spec);
    const existing = get().tabs.find((t) => identityKey(t) === key);
    if (existing) {
      set({ activeTabId: existing.id });
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
      return { tabs, activeTabId: id };
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
      return { tabs, activeTabId };
    }),

  focusTab: (id) => set((state) => (state.tabs.some((t) => t.id === id) ? { activeTabId: id } : state)),

  renameTab: (id, title) =>
    set((state) => ({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

  renameTerminalSession: (fromName, toName) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.kind === "terminal" && tab.sessionName === fromName
          ? { ...tab, sessionName: toName, title: toName }
          : tab,
      ),
    })),
}));

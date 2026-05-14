export type TaskWorkbenchKind = "ticket" | "session" | "project" | "app";

export interface TaskWorkbenchTab {
  id: string;
  kind: TaskWorkbenchKind;
  title: string;
  projectSlug?: string;
}

export interface TaskWorkbenchSnapshot {
  tabs: TaskWorkbenchTab[];
  activeTabId: string | null;
}

export function createTaskWorkbenchStore(initial: TaskWorkbenchSnapshot = { tabs: [], activeTabId: null }) {
  let state: TaskWorkbenchSnapshot = {
    tabs: [...initial.tabs],
    activeTabId: initial.activeTabId,
  };

  return {
    openTab(tab: TaskWorkbenchTab) {
      state = {
        tabs: [...state.tabs.filter((entry) => entry.id !== tab.id), tab],
        activeTabId: tab.id,
      };
    },
    activate(tabId: string) {
      if (!state.tabs.some((tab) => tab.id === tabId)) return;
      state = { ...state, activeTabId: tabId };
    },
    close(tabId: string) {
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      state = {
        tabs,
        activeTabId: state.activeTabId === tabId ? tabs[0]?.id ?? null : state.activeTabId,
      };
    },
    snapshot(): TaskWorkbenchSnapshot {
      return { tabs: [...state.tabs], activeTabId: state.activeTabId };
    },
  };
}

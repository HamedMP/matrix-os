// Per-task open editor tabs + dirty tracking. Serializable state only.
import { create } from "zustand";

const MAX_TABS_PER_TASK = 16;

interface EditorTabsState {
  tabsByTask: Record<string, string[]>;
  activePathByTask: Record<string, string | null>;
  dirtyPaths: string[];
  openTab: (taskId: string, path: string) => void;
  setActive: (taskId: string, path: string) => void;
  closeTab: (taskId: string, path: string) => void;
  setDirty: (path: string, dirty: boolean) => void;
  closeTask: (taskId: string) => void;
}

export const useEditorTabs = create<EditorTabsState>()((set) => ({
  tabsByTask: {},
  activePathByTask: {},
  dirtyPaths: [],

  openTab: (taskId, path) =>
    set((state) => {
      const existing = state.tabsByTask[taskId] ?? [];
      const tabs = existing.includes(path)
        ? existing
        : [...existing, path].slice(-MAX_TABS_PER_TASK);
      return {
        tabsByTask: { ...state.tabsByTask, [taskId]: tabs },
        activePathByTask: { ...state.activePathByTask, [taskId]: path },
      };
    }),

  setActive: (taskId, path) =>
    set((state) => ({
      activePathByTask: { ...state.activePathByTask, [taskId]: path },
    })),

  closeTab: (taskId, path) =>
    set((state) => {
      const tabs = (state.tabsByTask[taskId] ?? []).filter((p) => p !== path);
      const active =
        state.activePathByTask[taskId] === path
          ? (tabs[tabs.length - 1] ?? null)
          : (state.activePathByTask[taskId] ?? null);
      return {
        tabsByTask: { ...state.tabsByTask, [taskId]: tabs },
        activePathByTask: { ...state.activePathByTask, [taskId]: active },
        dirtyPaths: state.dirtyPaths.filter((p) => p !== path),
      };
    }),

  setDirty: (path, dirty) =>
    set((state) => ({
      dirtyPaths: dirty
        ? state.dirtyPaths.includes(path)
          ? state.dirtyPaths
          : [...state.dirtyPaths, path].slice(-64)
        : state.dirtyPaths.filter((p) => p !== path),
    })),

  closeTask: (taskId) =>
    set((state) => {
      const tabsByTask = { ...state.tabsByTask };
      const activePathByTask = { ...state.activePathByTask };
      delete tabsByTask[taskId];
      delete activePathByTask[taskId];
      return { tabsByTask, activePathByTask };
    }),
}));

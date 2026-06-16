// Per-task open editor tabs + dirty tracking. Serializable state only.
import { create } from "zustand";

const MAX_TABS_PER_TASK = 16;

interface EditorTabsState {
  tabsByTask: Record<string, string[]>;
  activePathByTask: Record<string, string | null>;
  dirtyPathsByTask: Record<string, string[]>;
  openTab: (taskId: string, path: string) => void;
  setActive: (taskId: string, path: string) => void;
  closeTab: (taskId: string, path: string) => void;
  setDirty: (taskId: string, path: string, dirty: boolean) => void;
  closeTask: (taskId: string) => void;
}

export const useEditorTabs = create<EditorTabsState>()((set) => ({
  tabsByTask: {},
  activePathByTask: {},
  dirtyPathsByTask: {},

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
        dirtyPathsByTask: {
          ...state.dirtyPathsByTask,
          [taskId]: (state.dirtyPathsByTask[taskId] ?? []).filter((p) => p !== path),
        },
      };
    }),

  setDirty: (taskId, path, dirty) =>
    set((state) => {
      const dirtyPaths = state.dirtyPathsByTask[taskId] ?? [];
      const nextDirtyPaths = dirty
        ? dirtyPaths.includes(path)
          ? dirtyPaths
          : [...dirtyPaths, path].slice(-64)
        : dirtyPaths.filter((p) => p !== path);
      return {
        dirtyPathsByTask: { ...state.dirtyPathsByTask, [taskId]: nextDirtyPaths },
      };
    }),

  closeTask: (taskId) =>
    set((state) => {
      const tabsByTask = { ...state.tabsByTask };
      const activePathByTask = { ...state.activePathByTask };
      const dirtyPathsByTask = { ...state.dirtyPathsByTask };
      delete tabsByTask[taskId];
      delete activePathByTask[taskId];
      delete dirtyPathsByTask[taskId];
      return {
        tabsByTask,
        activePathByTask,
        dirtyPathsByTask,
      };
    }),
}));

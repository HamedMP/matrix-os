import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useWindowManager } from "@/hooks/useWindowManager";

const GROUP_PADDING = 20;

export interface CanvasGroup {
  id: string;
  label: string;
  color: string;
  windowIds: string[];
  collapsed: boolean;
}

interface GroupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasGroupsState {
  groups: CanvasGroup[];
}

interface CanvasGroupsActions {
  createGroup: (label: string, color: string, windowIds?: string[]) => string;
  deleteGroup: (id: string) => void;
  renameGroup: (id: string, label: string) => void;
  setGroupColor: (id: string, color: string) => void;
  addToGroup: (groupId: string, windowId: string) => void;
  removeFromGroup: (groupId: string, windowId: string) => void;
  toggleCollapsed: (id: string) => void;
  getGroupBounds: (groupId: string) => GroupBounds | null;
  setGroups: (groups: CanvasGroup[]) => void;
}

export const useCanvasGroups = create<CanvasGroupsState & CanvasGroupsActions>()(
  subscribeWithSelector((set, get) => ({
    groups: [],

    createGroup: (label, color, windowIds = []) => {
      const id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      set((s) => ({
        groups: [...s.groups, { id, label, color, windowIds, collapsed: false }],
      }));
      return id;
    },

    deleteGroup: (id) => {
      set((s) => ({ groups: s.groups.filter((g) => g.id !== id) }));
    },

    renameGroup: (id, label) => {
      set((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, label } : g)),
      }));
    },

    setGroupColor: (id, color) => {
      set((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, color } : g)),
      }));
    },

    addToGroup: (groupId, windowId) => {
      set((s) => ({
        groups: s.groups.map((g) => {
          if (g.id === groupId) {
            if (g.windowIds.includes(windowId)) return g;
            return { ...g, windowIds: [...g.windowIds, windowId] };
          }
          // Enforce single-group membership: remove from other groups
          if (g.windowIds.includes(windowId)) {
            return { ...g, windowIds: g.windowIds.filter((id) => id !== windowId) };
          }
          return g;
        }),
      }));
    },

    removeFromGroup: (groupId, windowId) => {
      set((s) => ({
        groups: s.groups.map((g) =>
          g.id === groupId
            ? { ...g, windowIds: g.windowIds.filter((id) => id !== windowId) }
            : g,
        ),
      }));
    },

    toggleCollapsed: (id) => {
      set((s) => ({
        groups: s.groups.map((g) =>
          g.id === id ? { ...g, collapsed: !g.collapsed } : g,
        ),
      }));
    },

    getGroupBounds: (groupId) => {
      const group = get().groups.find((g) => g.id === groupId);
      if (!group || group.windowIds.length === 0) return null;

      const windows = useWindowManager.getState().windows;
      const members = windows.filter((w) => group.windowIds.includes(w.id));
      if (members.length === 0) return null;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of members) {
        minX = Math.min(minX, w.x);
        minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x + w.width);
        maxY = Math.max(maxY, w.y + w.height);
      }

      return {
        x: minX - GROUP_PADDING,
        y: minY - GROUP_PADDING,
        width: maxX - minX + GROUP_PADDING * 2,
        height: maxY - minY + GROUP_PADDING * 2,
      };
    },

    setGroups: (groups) => set({ groups }),
  })),
);

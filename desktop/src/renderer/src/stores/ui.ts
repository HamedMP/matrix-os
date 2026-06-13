// Transient overlay state (dialogs, palette). Navigation lives in the tabs
// store; this only tracks ephemeral open/closed flags.
import { create } from "zustand";

interface UiState {
  createProjectOpen: boolean;
  createTaskOpen: boolean;
  // The board column a new task should default to (set when opening the create
  // dialog from a specific column's "+"). null → default ("todo").
  createTaskStatus: string | null;
  composerOpen: boolean;
  paletteOpen: boolean;
  quickOpenOpen: boolean;
  sidebarCollapsed: boolean;
  setCreateProjectOpen: (open: boolean) => void;
  setCreateTaskOpen: (open: boolean) => void;
  openCreateTask: (status?: string) => void;
  setComposerOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUi = create<UiState>()((set) => ({
  createProjectOpen: false,
  createTaskOpen: false,
  createTaskStatus: null,
  composerOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  sidebarCollapsed: false,
  setCreateProjectOpen: (open) => set({ createProjectOpen: open }),
  setCreateTaskOpen: (open) => set({ createTaskOpen: open }),
  openCreateTask: (status) => set({ createTaskOpen: true, createTaskStatus: status ?? null }),
  setComposerOpen: (open) => set({ composerOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));

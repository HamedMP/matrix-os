// Transient overlay state (dialogs, palette). Navigation lives in the tabs
// store; this only tracks ephemeral open/closed flags.
import { create } from "zustand";

interface UiState {
  createProjectOpen: boolean;
  createProjectDestination: "board" | "agents";
  createTaskOpen: boolean;
  // The board column a new task should default to (set when opening the create
  // dialog from a specific column's "+"). null → default ("todo").
  createTaskStatus: string | null;
  composerOpen: boolean;
  paletteOpen: boolean;
  quickOpenOpen: boolean;
  sidebarCollapsed: boolean;
  // One-shot request for which Settings section the next Settings render
  // should select (consumed and cleared by SettingsView).
  requestedSettingsSection: string | null;
  setCreateProjectOpen: (open: boolean) => void;
  openCreateProject: (destination?: "board" | "agents") => void;
  setCreateTaskOpen: (open: boolean) => void;
  openCreateTask: (status?: string) => void;
  setComposerOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  requestSettingsSection: (section: string) => void;
  clearRequestedSettingsSection: () => void;
}

export const useUi = create<UiState>()((set) => ({
  createProjectOpen: false,
  createProjectDestination: "board",
  createTaskOpen: false,
  createTaskStatus: null,
  composerOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  sidebarCollapsed: false,
  requestedSettingsSection: null,
  setCreateProjectOpen: (open) => set({
    createProjectOpen: open,
    ...(open ? { createProjectDestination: "board" as const } : {}),
  }),
  openCreateProject: (destination = "board") => set({
    createProjectOpen: true,
    createProjectDestination: destination,
  }),
  setCreateTaskOpen: (open) => set({ createTaskOpen: open, createTaskStatus: null }),
  openCreateTask: (status) => set({ createTaskOpen: true, createTaskStatus: status ?? null }),
  setComposerOpen: (open) => set({ composerOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  requestSettingsSection: (section) => set({ requestedSettingsSection: section }),
  clearRequestedSettingsSection: () => set({ requestedSettingsSection: null }),
}));

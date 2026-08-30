// Transient overlay state (dialogs, palette). Navigation lives in the tabs
// store; this only tracks ephemeral open/closed flags.
import { create } from "zustand";

interface UiState {
  createProjectOpen: boolean;
  composerOpen: boolean;
  paletteOpen: boolean;
  quickOpenOpen: boolean;
  appLauncherOpen: boolean;
  // Native WebContentsViews always paint above the renderer. Any renderer
  // surface that crosses into an embed must hold one overlay lease so the
  // active embed can detach until that surface closes.
  rendererOverlayCount: number;
  homeRefreshRequest: number;
  desktopBackgroundRefreshRequest: number;
  // One-shot request for which Settings section the next Settings render
  // should select (consumed and cleared by SettingsView).
  requestedSettingsSection: string | null;
  setCreateProjectOpen: (open: boolean) => void;
  openCreateProject: () => void;
  setComposerOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
  setAppLauncherOpen: (open: boolean) => void;
  acquireRendererOverlay: () => void;
  releaseRendererOverlay: () => void;
  requestHomeRefresh: () => void;
  requestDesktopBackgroundRefresh: () => void;
  requestSettingsSection: (section: string) => void;
  clearRequestedSettingsSection: () => void;
}

export const useUi = create<UiState>()((set) => ({
  createProjectOpen: false,
  composerOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  appLauncherOpen: false,
  rendererOverlayCount: 0,
  homeRefreshRequest: 0,
  desktopBackgroundRefreshRequest: 0,
  requestedSettingsSection: null,
  setCreateProjectOpen: (open) => set({ createProjectOpen: open }),
  openCreateProject: () => set({ createProjectOpen: true }),
  setComposerOpen: (open) => set({ composerOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
  setAppLauncherOpen: (open) => set({ appLauncherOpen: open }),
  acquireRendererOverlay: () => set((state) => ({
    rendererOverlayCount: state.rendererOverlayCount + 1,
  })),
  releaseRendererOverlay: () => set((state) => ({
    rendererOverlayCount: Math.max(0, state.rendererOverlayCount - 1),
  })),
  requestHomeRefresh: () => set((state) => ({
    homeRefreshRequest: (state.homeRefreshRequest + 1) % 1_000_000,
  })),
  requestDesktopBackgroundRefresh: () => set((state) => ({
    desktopBackgroundRefreshRequest: (state.desktopBackgroundRefreshRequest + 1) % 1_000_000,
  })),
  requestSettingsSection: (section) => set({ requestedSettingsSection: section }),
  clearRequestedSettingsSection: () => set({ requestedSettingsSection: null }),
}));

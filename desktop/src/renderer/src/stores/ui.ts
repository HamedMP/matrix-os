// Transient overlay state (dialogs, palette). Navigation lives in the tabs
// store; this only tracks ephemeral open/closed flags.
import { create } from "zustand";

interface UiState {
  createTaskOpen: boolean;
  composerOpen: boolean;
  paletteOpen: boolean;
  quickOpenOpen: boolean;
  setCreateTaskOpen: (open: boolean) => void;
  setComposerOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
}

export const useUi = create<UiState>()((set) => ({
  createTaskOpen: false,
  composerOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  setCreateTaskOpen: (open) => set({ createTaskOpen: open }),
  setComposerOpen: (open) => set({ composerOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
}));

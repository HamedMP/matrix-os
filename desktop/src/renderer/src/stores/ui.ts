// Navigation + transient UI state. Serializable only.
import { create } from "zustand";

export type MainView =
  | { kind: "board" }
  | { kind: "task"; taskId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "sessions" }
  | { kind: "session"; sessionName: string }
  | { kind: "settings" };

interface UiState {
  view: MainView;
  createTaskOpen: boolean;
  composerOpen: boolean;
  paletteOpen: boolean;
  quickOpenOpen: boolean;
  navigate: (view: MainView) => void;
  setCreateTaskOpen: (open: boolean) => void;
  setComposerOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
}

export const useUi = create<UiState>()((set) => ({
  view: { kind: "board" },
  createTaskOpen: false,
  composerOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  navigate: (view) => set({ view }),
  setCreateTaskOpen: (open) => set({ createTaskOpen: open }),
  setComposerOpen: (open) => set({ composerOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
}));

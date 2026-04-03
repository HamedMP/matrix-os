import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type CanvasNavMode = "scroll" | "grab";

interface CanvasSettingsState {
  navMode: CanvasNavMode;
  showTitles: boolean;
}

interface CanvasSettingsActions {
  setNavMode: (mode: CanvasNavMode) => void;
  toggleNavMode: () => void;
  setShowTitles: (show: boolean) => void;
  toggleShowTitles: () => void;
}

export const useCanvasSettings = create<CanvasSettingsState & CanvasSettingsActions>()(
  subscribeWithSelector((set) => ({
    navMode: "scroll",
    showTitles: true,

    setNavMode: (navMode) => set({ navMode }),
    toggleNavMode: () =>
      set((s) => ({ navMode: s.navMode === "scroll" ? "grab" : "scroll" })),
    setShowTitles: (showTitles) => set({ showTitles }),
    toggleShowTitles: () => set((s) => ({ showTitles: !s.showTitles })),
  })),
);

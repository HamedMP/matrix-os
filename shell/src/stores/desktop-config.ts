import { create } from "zustand";

export interface DockConfig {
  position: "left" | "right" | "bottom";
  size: number;
  iconSize: number;
  autoHide: boolean;
}

interface DesktopConfigStore {
  dock: DockConfig;
  setDock: (dock: DockConfig) => void;
}

export const useDesktopConfigStore = create<DesktopConfigStore>((set) => ({
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  setDock: (dock) => set({ dock }),
}));

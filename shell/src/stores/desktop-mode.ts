import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DesktopMode = "desktop" | "ambient" | "dev" | "conversational";

export interface ModeConfig {
  id: DesktopMode;
  label: string;
  description: string;
  showDock: boolean;
  showWindows: boolean;
  showBottomPanel: boolean;
  chatPosition: "sidebar" | "center";
  terminalProminent?: boolean;
}

const MODE_CONFIGS: Record<DesktopMode, ModeConfig> = {
  desktop: {
    id: "desktop",
    label: "Desktop",
    description: "Full desktop with dock, windows, and sidebar chat",
    showDock: true,
    showWindows: true,
    showBottomPanel: false,
    chatPosition: "sidebar",
  },
  ambient: {
    id: "ambient",
    label: "Ambient",
    description: "Minimal mode with clock and centered chat",
    showDock: false,
    showWindows: false,
    showBottomPanel: false,
    chatPosition: "center",
  },
  dev: {
    id: "dev",
    label: "Dev",
    description: "Developer mode with prominent terminal and sidebar chat",
    showDock: true,
    showWindows: true,
    showBottomPanel: true,
    chatPosition: "sidebar",
    terminalProminent: true,
  },
  conversational: {
    id: "conversational",
    label: "Conversational",
    description: "Chat-centered mode for focused conversation",
    showDock: false,
    showWindows: false,
    showBottomPanel: false,
    chatPosition: "center",
  },
};

interface DesktopModeStore {
  mode: DesktopMode;
  setMode: (mode: DesktopMode) => void;
  getModeConfig: (mode: DesktopMode) => ModeConfig;
  allModes: () => ModeConfig[];
}

export const useDesktopMode = create<DesktopModeStore>()(
  persist(
    (set) => ({
      mode: "desktop" as DesktopMode,
      setMode: (mode: DesktopMode) => set({ mode }),
      getModeConfig: (mode: DesktopMode) => MODE_CONFIGS[mode],
      allModes: () => Object.values(MODE_CONFIGS),
    }),
    { name: "matrix-os-desktop-mode" },
  ),
);

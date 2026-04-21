import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DesktopMode = "desktop" | "canvas" | "ambient" | "dev";

export interface ModeConfig {
  id: DesktopMode;
  label: string;
  description: string;
  showDock: boolean;
  showWindows: boolean;
  showBottomPanel: boolean;
  chatPosition: "sidebar" | "center";
  terminalProminent?: boolean;
  // Hidden modes still work if set programmatically, but are filtered out of
  // the switcher, cycle, and command palette.
  hidden?: boolean;
}

const MODE_CONFIGS: Record<DesktopMode, ModeConfig> = {
  canvas: {
    id: "canvas",
    label: "Canvas",
    description: "Spatial canvas with zoom, pan, and app grouping",
    showDock: true,
    showWindows: true,
    showBottomPanel: false,
    chatPosition: "sidebar",
  },
  desktop: {
    id: "desktop",
    label: "Desktop",
    description: "Full desktop with dock, windows, and sidebar chat",
    showDock: true,
    showWindows: true,
    showBottomPanel: false,
    chatPosition: "sidebar",
    hidden: true,
  },
  ambient: {
    id: "ambient",
    label: "Ambient",
    description: "Minimal mode with clock and centered chat",
    showDock: false,
    showWindows: false,
    showBottomPanel: false,
    chatPosition: "center",
    hidden: true,
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
    hidden: true,
  },
};

const DEFAULT_MODE: DesktopMode = "canvas";

interface DesktopModeStore {
  mode: DesktopMode;
  previousMode: DesktopMode | null;
  _hydrated: boolean;
  setMode: (mode: DesktopMode) => void;
  getModeConfig: (mode: DesktopMode) => ModeConfig;
  allModes: () => ModeConfig[];
  visibleModes: () => ModeConfig[];
}

export const useDesktopMode = create<DesktopModeStore>()(
  persist(
    (set, get) => ({
      mode: DEFAULT_MODE,
      previousMode: null as DesktopMode | null,
      _hydrated: false,
      setMode: (mode: DesktopMode) => set({ previousMode: get().mode, mode }),
      getModeConfig: (mode: DesktopMode) => MODE_CONFIGS[mode],
      allModes: () => Object.values(MODE_CONFIGS),
      visibleModes: () => Object.values(MODE_CONFIGS).filter((m) => !m.hidden),
    }),
    {
      name: "matrix-os-desktop-mode",
      onRehydrateStorage: () => (state) => {
        // Coerce any persisted hidden mode (desktop/ambient/dev) or the
        // now-removed "vocal" mode into canvas. Aoede is an overlay now
        // (see `stores/vocal.ts`), not a mode.
        const config = state ? MODE_CONFIGS[state.mode] : undefined;
        if (state && (!config || config.hidden)) {
          state.mode = DEFAULT_MODE;
          state.previousMode = null;
        }
        useDesktopMode.setState({ _hydrated: true });
      },
    },
  ),
);

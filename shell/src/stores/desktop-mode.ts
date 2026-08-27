import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TerminalIcon, LayoutGridIcon, MonitorIcon, AudioWaveformIcon, type LucideIcon } from "@/lib/hugeicons";

export type DesktopMode = "desktop" | "canvas" | "ambient" | "dev";

export interface ModeConfig {
  id: DesktopMode;
  label: string;
  description: string;
  icon: LucideIcon;
  showDock: boolean;
  showWindows: boolean;
  showBottomPanel: boolean;
  showLauncher: boolean;
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
    icon: LayoutGridIcon,
    showDock: true,
    showWindows: true,
    showBottomPanel: false,
    showLauncher: true,
    chatPosition: "sidebar",
  },
  desktop: {
    id: "desktop",
    label: "Desktop",
    description: "Full desktop with dock, windows, and sidebar chat",
    icon: MonitorIcon,
    showDock: true,
    showWindows: true,
    showBottomPanel: false,
    showLauncher: true,
    chatPosition: "sidebar",
    hidden: false,
  },
  ambient: {
    id: "ambient",
    label: "Ambient",
    description: "Minimal mode with clock and centered chat",
    icon: AudioWaveformIcon,
    showDock: false,
    showWindows: false,
    showBottomPanel: false,
    showLauncher: false,
    chatPosition: "center",
    hidden: true,
  },
  dev: {
    id: "dev",
    label: "Developer",
    description: "Terminal-first setup with Symphony and Canvas one click away",
    icon: TerminalIcon,
    showDock: true,
    showWindows: true,
    showBottomPanel: true,
    showLauncher: true,
    chatPosition: "sidebar",
    terminalProminent: true,
    hidden: true,
  },
};

const DEFAULT_MODE: DesktopMode = "desktop";

/**
 * The native Desktop renderer is the canonical OS view. Keep the legacy mode
 * identifiers readable so old snapshots do not break, but migrate every
 * persisted renderer selection to Desktop until those renderers share the
 * native shell contract.
 */
export function normalizeDesktopMode(_value: unknown): DesktopMode {
  return DEFAULT_MODE;
}

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
      visibleModes: () => [MODE_CONFIGS.desktop],
    }),
    {
      name: "matrix-os-desktop-mode",
      onRehydrateStorage: () => (state) => {
        // The web OS now follows the native Desktop renderer. Legacy
        // Developer/Canvas/Ambient values remain parseable for old layouts,
        // then migrate to the canonical Desktop surface during hydration.
        if (state) {
          state.mode = normalizeDesktopMode(state.mode);
          state.previousMode = null;
        }
        useDesktopMode.setState({ _hydrated: true });
      },
    },
  ),
);

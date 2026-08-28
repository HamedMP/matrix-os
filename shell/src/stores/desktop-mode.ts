import { create } from "zustand";
import { persist } from "zustand/middleware";
import { LayoutGridIcon, MonitorIcon, type LucideIcon } from "@/lib/hugeicons";

export type DesktopMode = "desktop" | "canvas";

export interface ModeConfig {
  id: DesktopMode;
  label: string;
  description: string;
  icon: LucideIcon;
}

const MODE_CONFIGS: Record<DesktopMode, ModeConfig> = {
  canvas: {
    id: "canvas",
    label: "Canvas",
    description: "Spatial canvas with zoom, pan, and app grouping",
    icon: LayoutGridIcon,
  },
  desktop: {
    id: "desktop",
    label: "Desktop",
    description: "Full desktop with dock, windows, and sidebar chat",
    icon: MonitorIcon,
  },
};

const DEFAULT_MODE: DesktopMode = "desktop";

/**
 * The native Desktop renderer is the canonical OS view. Keep legacy mode
 * values readable so old snapshots migrate safely; only Desktop and Canvas
 * remain live user preferences.
 */
export function normalizeDesktopMode(value: unknown): DesktopMode {
  if (value === "canvas") return "canvas";
  return DEFAULT_MODE;
}

interface DesktopModeStore {
  mode: DesktopMode;
  previousMode: DesktopMode | null;
  _hydrated: boolean;
  setMode: (mode: DesktopMode) => void;
  allModes: () => ModeConfig[];
  visibleModes: () => ModeConfig[];
}

export const useDesktopMode = create<DesktopModeStore>()(
  persist(
    (set, get) => ({
      mode: DEFAULT_MODE,
      previousMode: null,
      _hydrated: false,
      setMode: (mode: DesktopMode) => set({ previousMode: get().mode, mode }),
      allModes: () => Object.values(MODE_CONFIGS),
      visibleModes: () => [MODE_CONFIGS.canvas, MODE_CONFIGS.desktop],
    }),
    {
      name: "matrix-os-desktop-mode",
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.mode = normalizeDesktopMode(state.mode);
          state.previousMode = null;
        }
        useDesktopMode.setState({ _hydrated: true });
      },
    },
  ),
);

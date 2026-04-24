import { create } from "zustand";

/**
 * Aoede is an ambient overlay, not a desktop mode. It can coexist with
 * any `DesktopMode` so the user can keep their workspace visible while
 * Aoede speaks. `active` is session-only (not persisted) — reloading the
 * shell shouldn't auto-prompt for mic permission.
 */
interface VocalStore {
  active: boolean;
  toggle: () => void;
  setActive: (active: boolean) => void;
}

export const useVocalStore = create<VocalStore>()((set) => ({
  active: false,
  toggle: () => set((s) => ({ active: !s.active })),
  setActive: (active) => set({ active }),
}));

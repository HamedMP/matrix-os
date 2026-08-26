import { create } from "zustand";

interface DesktopAppDrawerState {
  open: boolean;
  setOpen(open: boolean): void;
  toggle(): void;
}

// This is deliberately renderer-local UI state. Tabs and desktop surfaces remain
// the durable source for which apps exist and how they are presented.
export const useDesktopAppDrawer = create<DesktopAppDrawerState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));

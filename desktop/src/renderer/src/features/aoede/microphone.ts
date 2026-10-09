import { create } from "zustand";

// Opening Aoede disposes Chat dictation before another capture can begin.
export const useDesktopAoede = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false, setOpen: (open) => set({ open }),
}));

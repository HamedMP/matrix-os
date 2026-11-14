import { create } from "zustand";

/**
 * Aoede is an ambient overlay, not a desktop mode. It can coexist with
 * any `DesktopMode` so the user can keep their workspace visible while
 * Aoede speaks. `active` is session-only (not persisted) — reloading the
 * shell shouldn't auto-prompt for mic permission.
 *
 * `chatId` is the Chat a live call joins; undefined means the owner's most
 * recent generic Matrix Pi Chat, chosen by the gateway.
 */
interface VocalStore {
  active: boolean;
  chatId: string | undefined;
  toggle: () => void;
  setActive: (active: boolean) => void;
  startInChat: (chatId: string | undefined) => void;
}

export const useVocalStore = create<VocalStore>()((set) => ({
  active: false,
  chatId: undefined,
  toggle: () => set((s) => ({ active: !s.active, chatId: s.active ? s.chatId : undefined })),
  setActive: (active) => set({ active }),
  startInChat: (chatId) => set({ active: true, chatId }),
}));

import { create } from "zustand";

interface DesktopVoiceCallState {
  active: boolean;
  /** Chat the call joins; undefined joins the most recent generic Matrix Pi Chat. */
  chatId: string | undefined;
  start(chatId?: string): void;
  end(): void;
  toggle(): void;
}

export const useDesktopVoiceCall = create<DesktopVoiceCallState>((set) => ({
  active: false,
  chatId: undefined,
  start: (chatId) => set({ active: true, chatId }),
  end: () => set({ active: false }),
  toggle: () => set((state) => (state.active ? { active: false } : { active: true, chatId: undefined })),
}));

/** `/ws/voice/live` on the selected computer, reached through the platform
 * the same way as the kernel socket. */
export function buildVoiceLiveWsUrl(platformHost: string, runtimeSlot: string, chatId?: string): string {
  const url = new URL(`${platformHost.replace(/\/+$/, "").replace(/^http/, "ws")}/ws/voice/live`);
  if (runtimeSlot !== "primary") url.searchParams.set("runtime", runtimeSlot);
  if (chatId) url.searchParams.set("chatId", chatId);
  return url.toString();
}

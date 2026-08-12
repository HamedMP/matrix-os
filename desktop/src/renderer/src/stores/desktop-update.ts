import { create } from "zustand";
import type {
  DesktopReleaseNotes,
  DesktopUpdateSnapshot,
} from "../../../shared/desktop-update";
import { invoke, onEvent } from "../lib/operator";

interface DesktopUpdateState {
  snapshot: DesktopUpdateSnapshot;
  release: DesktopReleaseNotes | null;
  whatsNewOpen: boolean;
  installing: boolean;
  initialize: () => () => void;
  install: () => Promise<void>;
  closeWhatsNew: () => void;
}

export const useDesktopUpdate = create<DesktopUpdateState>()((set, get) => ({
  snapshot: { status: "disabled" },
  release: null,
  whatsNewOpen: false,
  installing: false,

  initialize: () => {
    if (
      typeof window === "undefined" ||
      typeof window.operator?.invoke !== "function" ||
      typeof window.operator?.on !== "function"
    ) {
      return () => undefined;
    }
    let active = true;
    let eventReceived = false;
    const unsubscribe = onEvent("update:state-changed", (snapshot) => {
      eventReceived = true;
      if (active) set({ snapshot });
    });

    void Promise.all([
      invoke("update:get-state", {}),
      invoke("update:get-whats-new", {}),
    ])
      .then(([snapshot, whatsNew]) => {
        if (!active) return;
        set({
          ...(!eventReceived ? { snapshot } : {}),
          release: whatsNew.release,
          whatsNewOpen: whatsNew.shouldOpen && Boolean(whatsNew.release),
        });
      })
      .catch(() => {
        console.warn("[desktop-update] could not initialize update state");
      });

    return () => {
      active = false;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  },

  install: async () => {
    if (get().snapshot.status !== "ready" || get().installing) return;
    set({ installing: true });
    try {
      const result = await invoke("update:install", {});
      if (!result.ok) set({ installing: false });
    } catch {
      set({ installing: false });
      console.warn("[desktop-update] restart and install failed");
    }
  },

  closeWhatsNew: () => {
    const release = get().release;
    set({ whatsNewOpen: false });
    if (!release) return;
    void invoke("update:acknowledge-whats-new", { version: release.version }).catch(() => {
      console.warn("[desktop-update] could not acknowledge What's New");
    });
  },
}));

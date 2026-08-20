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
  manualDialogOpen: boolean;
  installing: boolean;
  initialize: () => () => void;
  check: () => Promise<void>;
  install: () => Promise<void>;
  closeManualDialog: () => void;
  closeWhatsNew: () => void;
}

export const useDesktopUpdate = create<DesktopUpdateState>()((set, get) => ({
  snapshot: { status: "disabled" },
  release: null,
  whatsNewOpen: false,
  manualDialogOpen: false,
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
    const unsubscribeState = onEvent("update:state-changed", (snapshot) => {
      eventReceived = true;
      if (active) set({ snapshot });
    });
    const unsubscribeManualCheck = onEvent("update:manual-check-requested", () => {
      if (!active) return;
      set((state) => ({
        manualDialogOpen: true,
        snapshot: state.snapshot.status === "checking"
          || state.snapshot.status === "downloading"
          || state.snapshot.status === "ready"
          ? state.snapshot
          : { status: "checking" },
      }));
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
      if (typeof unsubscribeState === "function") unsubscribeState();
      if (typeof unsubscribeManualCheck === "function") unsubscribeManualCheck();
    };
  },

  check: async () => {
    set({ manualDialogOpen: true });
    try {
      const snapshot = await invoke("update:check", {});
      set({ snapshot });
    } catch {
      set({ snapshot: { status: "error" } });
      console.warn("[desktop-update] update check failed");
    }
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

  closeManualDialog: () => set({ manualDialogOpen: false }),

  closeWhatsNew: () => {
    const release = get().release;
    set({ whatsNewOpen: false });
    if (!release) return;
    void invoke("update:acknowledge-whats-new", { version: release.version }).catch(() => {
      console.warn("[desktop-update] could not acknowledge What's New");
    });
  },
}));

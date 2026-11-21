import { create } from "zustand";
import type {
  DesktopReleaseNotes,
  DesktopUpdateSnapshot,
} from "../../../shared/desktop-update";
import type { ReleaseNotesChannel } from "../../../shared/release-notes";
import { diagnosticErrorKind } from "../lib/errors";
import { invoke, onEvent } from "../lib/operator";
import { whatsNewPreviewRequested } from "../features/updates/whats-new-preview";

interface DesktopUpdateState {
  snapshot: DesktopUpdateSnapshot;
  release: DesktopReleaseNotes | null;
  whatsNewOpen: boolean;
  /** True while the installed release's What's New has not been acknowledged. */
  whatsNewUnseen: boolean;
  /** The running build's release channel, once known. */
  buildChannel: ReleaseNotesChannel | null;
  manualDialogOpen: boolean;
  installing: boolean;
  initialize: () => () => void;
  check: () => Promise<void>;
  install: () => Promise<void>;
  closeManualDialog: () => void;
  /** Opens What's New on demand, e.g. from the account menu. */
  openWhatsNew: () => void;
  closeWhatsNew: () => void;
}

export const useDesktopUpdate = create<DesktopUpdateState>()((set, get) => ({
  snapshot: { status: "disabled" },
  release: null,
  whatsNewOpen: false,
  whatsNewUnseen: false,
  buildChannel: null,
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
    if (whatsNewPreviewRequested()) set({ whatsNewOpen: true });
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

    void invoke("app:get-version", {})
      .then((info) => {
        const channel = info?.channel;
        if (active && (channel === "stable" || channel === "beta" || channel === "canary" || channel === "dev")) {
          set({ buildChannel: channel });
        }
      })
      .catch((err: unknown) => {
        console.warn("[desktop-update] could not read the build channel:", diagnosticErrorKind(err));
      });

    void Promise.all([
      invoke("update:get-state", {}),
      invoke("update:get-whats-new", {}),
    ])
      .then(([snapshot, whatsNew]) => {
        if (!active) return;
        set((state) => ({
          ...(!eventReceived ? { snapshot } : {}),
          release: whatsNew.release,
          whatsNewUnseen: whatsNew.shouldOpen && Boolean(whatsNew.release),
          // Never close a What's New the user opened while this was loading.
          whatsNewOpen: state.whatsNewOpen || (whatsNew.shouldOpen && Boolean(whatsNew.release)),
        }));
      })
      .catch((err: unknown) => {
        console.warn(
          "[desktop-update] could not initialize update state:",
          diagnosticErrorKind(err),
        );
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
    } catch (err: unknown) {
      set({ snapshot: { status: "error" } });
      console.warn("[desktop-update] update check failed:", diagnosticErrorKind(err));
    }
  },

  install: async () => {
    if (get().snapshot.status !== "ready" || get().installing) return;
    set({ installing: true });
    try {
      const result = await invoke("update:install", {});
      if (!result.ok) set({ installing: false });
    } catch (err: unknown) {
      set({ installing: false });
      console.warn("[desktop-update] restart and install failed:", diagnosticErrorKind(err));
    }
  },

  closeManualDialog: () => set({ manualDialogOpen: false }),

  openWhatsNew: () => set({ whatsNewOpen: true }),

  closeWhatsNew: () => {
    const release = get().release;
    set({ whatsNewOpen: false, whatsNewUnseen: false });
    if (!release) return;
    void invoke("update:acknowledge-whats-new", { version: release.version }).catch(
      (err: unknown) => {
        console.warn(
          "[desktop-update] could not acknowledge What's New:",
          diagnosticErrorKind(err),
        );
      },
    );
  },
}));

/** Opens the What's New release history at any time (account menu, palette). */
export function openWhatsNew(): void {
  useDesktopUpdate.getState().openWhatsNew();
}

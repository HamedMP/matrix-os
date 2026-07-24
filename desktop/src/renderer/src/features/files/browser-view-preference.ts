// View-mode preference for the computer file browser (grid vs list). Kept in
// a module store so every browser instance — Files workspace, inspector
// panel, folder pickers — shares one choice and it survives unmount/remount
// within the app session.
//
// Cross-restart persistence is intentionally not wired here: the desktop
// local store only accepts a closed set of keys (STATE_KEYS in
// desktop/src/shared/ipc-contract.ts, validated again by KEY_SCHEMAS in
// desktop/src/main/persistence/local-store.ts), and both live outside this
// feature's ownership. Persisting across restarts needs a "filesBrowser" key
// added in those two places; the setView seam below is where the
// state:get/state:set round-trip would attach.
import { create } from "zustand";

export type BrowserViewMode = "grid" | "list";

interface BrowserViewPreferenceState {
  view: BrowserViewMode;
  setView: (view: BrowserViewMode) => void;
}

export const useBrowserViewPreference = create<BrowserViewPreferenceState>()((set) => ({
  view: "list",
  setView: (view) => set({ view }),
}));

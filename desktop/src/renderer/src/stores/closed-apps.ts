// Session-only history of closed apps for "Reopen closed app". Entries are tab
// descriptions (what to open), never window placement, and live in memory only.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { useTabs, type Tab } from "./tabs";

export const CLOSED_APPS_LIMIT = 10;

export type ClosedAppSpec = Omit<Tab, "id" | "closable">;

interface ClosedAppsState {
  entries: ClosedAppSpec[];
  push(tab: Tab): void;
  pop(): ClosedAppSpec | null;
}

function closedAppSpec(tab: Tab): ClosedAppSpec {
  const { id: _id, closable: _closable, sessionName, ...spec } = tab;
  if (spec.kind === "terminal" && !spec.sharedScopeId) {
    // A session-bound terminal tab without its session is pruned on reconcile,
    // so a closed terminal reopens as the terminal workspace with a new session.
    return { kind: "terminals", title: "Terminal" };
  }
  if (spec.kind === "terminal" || spec.kind === "terminals") return spec;
  return sessionName === undefined ? spec : { ...spec, sessionName };
}

export const useClosedApps: UseBoundStore<StoreApi<ClosedAppsState>> = create<ClosedAppsState>()((set, get) => ({
  entries: [],

  push: (tab) => set((state) => ({
    entries: [...state.entries, closedAppSpec(tab)].slice(-CLOSED_APPS_LIMIT),
  })),

  pop: () => {
    const { entries } = get();
    const last = entries.at(-1);
    if (!last) return null;
    set({ entries: entries.slice(0, -1) });
    return last;
  },
}));

/** Records `tab` only if closing it actually removed it from the tab workspace. */
export function recordClosedAppIfRemoved(tab: Tab): void {
  if (useTabs.getState().tabs.some((candidate) => candidate.id === tab.id)) return;
  useClosedApps.getState().push(tab);
}

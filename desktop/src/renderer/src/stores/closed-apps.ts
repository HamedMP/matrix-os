// Session-only history of closed apps for "Reopen closed app". Entries are tab
// descriptions (what to open), never window placement, and live in memory only.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { useDesktopSurfaces } from "./desktop-surfaces";
import { useTabs, type Tab } from "./tabs";

export const CLOSED_APPS_LIMIT = 10;

/** Keeps `closable` so an app that cannot be closed reopens the same way. */
export type ClosedAppSpec = Omit<Tab, "id">;

interface ClosedAppsState {
  entries: ClosedAppSpec[];
  push(tab: Tab): void;
  pop(): ClosedAppSpec | null;
}

function closedAppSpec(tab: Tab): ClosedAppSpec {
  const { id: _id, sessionName, ...spec } = tab;
  if (spec.kind === "terminal" && !spec.sharedScopeId) {
    // A session-bound terminal tab without its session is pruned on reconcile,
    // so a closed terminal reopens as its project's terminal workspace with a
    // new session.
    const reopened: ClosedAppSpec = { kind: "terminals", title: "Terminal", closable: true };
    return spec.projectSlug === undefined ? reopened : { ...reopened, projectSlug: spec.projectSlug };
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

/**
 * Records `tab` after a close if the close took effect: its tab left the
 * workspace, or (for apps that cannot be closed) its surface is now closed.
 */
export function recordClosedApp(tab: Tab): void {
  const removed = !useTabs.getState().tabs.some((candidate) => candidate.id === tab.id);
  const surfaceClosed = useDesktopSurfaces.getState().surfaces[tab.id]?.mode === "closed";
  if (removed || surfaceClosed) useClosedApps.getState().push(tab);
}

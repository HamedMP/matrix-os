import { create } from "zustand";
import { z } from "zod/v4";

const MAX_GUARDED_WINDOWS = 64;
const UTILITIES_PATH = /^apps\/utilities(?:\/(?:index\.html)?)?$/;
interface Guard { owner: string; dirty: boolean }
interface PendingClose { id: string; path: string; all: boolean }
interface CloseGuardState {
  guards: Record<string, Guard>;
  pending: PendingClose | null;
  register: (id: string, owner: string) => void;
  update: (id: string, owner: string, dirty: boolean) => void;
  release: (id: string, owner: string) => void;
  cancel: () => void;
  approve: (id: string, owner: string) => void;
}

export const useUtilitiesCloseGuard = create<CloseGuardState>((set) => ({
  guards: {}, pending: null,
  register: (id, owner) => set((state) => {
    const entries = Object.entries(state.guards).filter(([key]) => key !== id);
    // Bounded FIFO eviction. An evicted live Utilities window fails closed at
    // request time, so eviction can never silently discard temporary input.
    const guards = Object.fromEntries(entries.slice(-(MAX_GUARDED_WINDOWS - 1)));
    return { guards: { ...guards, [id]: { owner, dirty: false } } };
  }),
  update: (id, owner, dirty) => set((state) => state.guards[id]?.owner === owner
    ? { guards: { ...state.guards, [id]: { owner, dirty } } } : state),
  release: (id, owner) => set((state) => {
    if (state.guards[id] && state.guards[id].owner !== owner) return state;
    const guards = { ...state.guards }; delete guards[id];
    return { guards, pending: state.pending?.id === id ? null : state.pending };
  }),
  cancel: () => set({ pending: null }),
  approve: (id, owner) => set((state) => {
    if (state.pending?.id !== id || (state.guards[id] && state.guards[id].owner !== owner)) return state;
    const entries = Object.entries(state.guards).filter(([key]) => key !== id);
    const guards = Object.fromEntries(entries.slice(-(MAX_GUARDED_WINDOWS - 1)));
    return { guards: { ...guards, [id]: { owner, dirty: false } }, pending: null };
  }),
}));

/** All presentation close controls reach the shared window manager first. */
export function deferUtilitiesWindowClose(win: { id: string; path: string } | undefined, all = false): boolean {
  if (!win || !UTILITIES_PATH.test(win.path)) return false;
  const state = useUtilitiesCloseGuard.getState();
  if (state.guards[win.id]?.dirty === false) return false;
  useUtilitiesCloseGuard.setState({ pending: { id: win.id, path: win.path, all } });
  return true;
}

const UtilitiesWorkspaceStateSchema = z.object({
  type: z.literal("matrix-os:utilities-workspace-state"),
  app: z.literal("utilities"),
  dirty: z.boolean(),
}).strict();
export type UtilitiesWorkspaceStateMessage = z.infer<typeof UtilitiesWorkspaceStateSchema>;

export function readUtilitiesWorkspaceState(data: unknown): UtilitiesWorkspaceStateMessage | null {
  if (data === null || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 3) return null;
  const result = UtilitiesWorkspaceStateSchema.safeParse(data);
  return result.success ? result.data : null;
}

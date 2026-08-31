import { resolveBrowserAddress } from "../../../shared/runtime-browser-url";
import { create } from "zustand";
import { useConnection } from "./connection";

const MAX_BROWSER_ADDRESS_LENGTH = 4_096;
const MAX_PENDING_NAVIGATIONS = 8;

export interface BrowserNavigationRequest {
  id: number;
  url: string;
  runtimeScope: string;
}

export function browserRuntimeScope({
  platformHost,
  handle,
  runtimeSlot,
  authGeneration,
}: {
  platformHost: string;
  handle: string | null;
  runtimeSlot: string;
  authGeneration: number;
}): string {
  return JSON.stringify([platformHost, handle, runtimeSlot, authGeneration]);
}

interface BrowserNavigationState {
  pending: BrowserNavigationRequest | null;
  queued: BrowserNavigationRequest[];
  sequence: number;
  request(address: string, runtimeScope?: string): number | null;
  consume(id: number): void;
}

export const useBrowserNavigation = create<BrowserNavigationState>()((set, get) => ({
  pending: null,
  queued: [],
  sequence: 0,
  request: (address, requestedRuntimeScope) => {
    if (address.length > MAX_BROWSER_ADDRESS_LENGTH) return null;
    const resolved = resolveBrowserAddress(address);
    if (!resolved) return null;
    const state = get();
    const pendingCount = state.queued.length + (state.pending ? 1 : 0);
    if (pendingCount >= MAX_PENDING_NAVIGATIONS) return null;
    const id = state.sequence + 1;
    const { platformHost, handle, runtimeSlot, authGeneration } = useConnection.getState();
    const runtimeScope = requestedRuntimeScope
      ?? browserRuntimeScope({ platformHost, handle, runtimeSlot, authGeneration });
    const requests = [
      ...state.queued,
      ...(state.pending ? [state.pending] : []),
      {
        id,
        url: resolved.url,
        runtimeScope,
      },
    ];
    set({
      pending: requests.at(-1) ?? null,
      queued: requests.slice(0, -1),
      sequence: id,
    });
    return id;
  },
  consume: (id) => set((state) => {
    const requests = [
      ...state.queued,
      ...(state.pending ? [state.pending] : []),
    ];
    if (!requests.some((request) => request.id === id)) return state;
    const remaining = requests.filter((request) => request.id !== id);
    return {
      pending: remaining.at(-1) ?? null,
      queued: remaining.slice(0, -1),
    };
  }),
}));

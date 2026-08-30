import { resolveBrowserAddress } from "../../../shared/runtime-browser-url";
import { create } from "zustand";

const MAX_BROWSER_ADDRESS_LENGTH = 4_096;

export interface BrowserNavigationRequest {
  id: number;
  url: string;
}

interface BrowserNavigationState {
  pending: BrowserNavigationRequest | null;
  sequence: number;
  request(address: string): number | null;
  consume(id: number): void;
}

export const useBrowserNavigation = create<BrowserNavigationState>()((set, get) => ({
  pending: null,
  sequence: 0,
  request: (address) => {
    if (address.length > MAX_BROWSER_ADDRESS_LENGTH) return null;
    const resolved = resolveBrowserAddress(address);
    if (!resolved) return null;
    const id = get().sequence + 1;
    set({ pending: { id, url: resolved.url }, sequence: id });
    return id;
  },
  consume: (id) => set((state) => (
    state.pending?.id === id ? { pending: null } : state
  )),
}));

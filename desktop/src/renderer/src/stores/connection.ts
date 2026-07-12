// Connection/auth status store. Holds NO credential — only status snapshots
// from the trusted core (FR-002).
import { create } from "zustand";
import { invoke, onEvent } from "../lib/operator";
import { createApiClient, type ApiClient } from "../lib/api";
import { reconcileDesktopRuntimeChange } from "./runtime-transition";

export type ConnectionStatus = "loading" | "signed-out" | "signed-in";

interface ConnectionState {
  status: ConnectionStatus;
  handle: string | null;
  displayName: string | null;
  imageUrl: string | null;
  platformHost: string;
  runtimeSlot: string;
  api: ApiClient | null;
  refresh: () => Promise<void>;
  selectRuntime: (slot: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useConnection = create<ConnectionState>()((set, get) => ({
  status: "loading",
  handle: null,
  displayName: null,
  imageUrl: null,
  platformHost: "",
  runtimeSlot: "primary",
  api: null,

  refresh: async () => {
    try {
      const status = await invoke("auth:status", {});
      const api = status.signedIn
        ? createApiClient({
            baseUrl: status.platformHost,
            getRuntimeSlot: () => get().runtimeSlot,
            // A 401 means the session token expired/was revoked. Drop it in the
            // trusted core (which emits auth:changed → refresh → sign-in screen).
            onUnauthorized: () => {
              void invoke("auth:session-expired", {});
            },
          })
        : null;
      set({
        status: status.signedIn ? "signed-in" : "signed-out",
        handle: status.handle ?? null,
        displayName: status.displayName ?? null,
        imageUrl: status.imageUrl ?? null,
        platformHost: status.platformHost,
        runtimeSlot: status.runtimeSlot,
        api,
      });
    } catch (err: unknown) {
      console.warn("[connection] failed to refresh auth status:", err instanceof Error ? err.message : String(err));
      set({ status: "signed-out", handle: null, displayName: null, imageUrl: null, api: null });
    }
  },

  selectRuntime: async (slot) => {
    reconcileDesktopRuntimeChange();
    try {
      await invoke("runtime:select", { slot });
      set({ runtimeSlot: slot });
    } catch (err: unknown) {
      // Recreate the API client so runtime-bound surfaces reload the still
      // selected computer after a failed switch.
      await get().refresh();
      throw err;
    }
  },

  signOut: async () => {
    await invoke("auth:sign-out", {});
    set({ status: "signed-out", handle: null, displayName: null, imageUrl: null, api: null });
  },
}));

let wired = false;
let connectionEventCleanups: Array<() => void> = [];

function refreshFromConnectionEvent(): void {
  void useConnection
    .getState()
    .refresh()
    .catch((err: unknown) => {
      console.warn("[connection] failed to refresh after connection event:", err instanceof Error ? err.message : String(err));
    });
}

export function wireConnectionEvents(): void {
  if (wired) return;
  wired = true;
  connectionEventCleanups = [
    onEvent("auth:changed", refreshFromConnectionEvent),
    onEvent("runtime:changed", refreshFromConnectionEvent),
  ];
}

export function unwireConnectionEvents(): void {
  for (const cleanup of connectionEventCleanups) {
    cleanup();
  }
  connectionEventCleanups = [];
  wired = false;
}

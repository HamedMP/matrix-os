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
  // Trusted-core credential generation; advances on every credential
  // replacement so caches keyed on visible identity cannot cross sessions.
  authGeneration: number;
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
  authGeneration: 0,
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
        authGeneration: status.authGeneration,
        api,
      });
    } catch (err: unknown) {
      console.warn("[connection] failed to refresh auth status:", err instanceof Error ? err.message : String(err));
      set({ status: "signed-out", handle: null, displayName: null, imageUrl: null, api: null });
    }
  },

  selectRuntime: async (slot) => {
    // The trusted core emits runtime:changed before the runtime:select invoke
    // resolves. If the wired listener refreshed immediately, the new slot and
    // API would become observable before reconciliation, letting surfaces load
    // the new computer under the old runtime generation only to be wiped.
    runtimeSwitchesInFlight += 1;
    try {
      await invoke("runtime:select", { slot });
      // Clear previous-computer state only after the trusted core confirms the
      // switch, and before the new slot becomes observable to the UI.
      reconcileDesktopRuntimeChange();
      set({ runtimeSlot: slot });
    } catch (err: unknown) {
      // The switch never happened: keep every surface on the still-selected
      // computer and refresh the auth snapshot so the API client stays valid.
      await get().refresh();
      throw err;
    } finally {
      runtimeSwitchesInFlight -= 1;
    }
    // Publish the post-switch snapshot (handle, authGeneration, API) now that
    // the previous computer's state is gone.
    await get().refresh();
  },

  signOut: async () => {
    await invoke("auth:sign-out", {});
    set({ status: "signed-out", handle: null, displayName: null, imageUrl: null, api: null });
  },
}));

let wired = false;
let connectionEventCleanups: Array<() => void> = [];
let runtimeSwitchesInFlight = 0;

function refreshFromConnectionEvent(): void {
  void useConnection
    .getState()
    .refresh()
    .catch((err: unknown) => {
      console.warn("[connection] failed to refresh after connection event:", err instanceof Error ? err.message : String(err));
    });
}

function refreshFromRuntimeChangedEvent(): void {
  // selectRuntime reconciles and refreshes itself; refreshing here would
  // publish the new slot before the previous computer's state is cleared.
  if (runtimeSwitchesInFlight > 0) return;
  refreshFromConnectionEvent();
}

export function wireConnectionEvents(): void {
  if (wired) return;
  wired = true;
  connectionEventCleanups = [
    onEvent("auth:changed", refreshFromConnectionEvent),
    onEvent("runtime:changed", refreshFromRuntimeChangedEvent),
  ];
}

export function unwireConnectionEvents(): void {
  for (const cleanup of connectionEventCleanups) {
    cleanup();
  }
  connectionEventCleanups = [];
  wired = false;
}

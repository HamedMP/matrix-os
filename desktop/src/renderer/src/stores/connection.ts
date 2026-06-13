// Connection/auth status store. Holds NO credential — only status snapshots
// from the trusted core (FR-002).
import { create } from "zustand";
import { invoke, onEvent } from "../lib/operator";
import { createApiClient, type ApiClient } from "../lib/api";

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
  },

  selectRuntime: async (slot) => {
    await invoke("runtime:select", { slot });
    set({ runtimeSlot: slot });
  },

  signOut: async () => {
    await invoke("auth:sign-out", {});
    set({ status: "signed-out", handle: null, displayName: null, imageUrl: null, api: null });
  },
}));

let wired = false;

export function wireConnectionEvents(): void {
  if (wired) return;
  wired = true;
  onEvent("auth:changed", () => {
    void useConnection.getState().refresh();
  });
  onEvent("runtime:changed", () => {
    void useConnection.getState().refresh();
  });
}

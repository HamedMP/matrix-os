import { create } from "zustand";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

interface ConnectionHealthState {
  state: ConnectionState;
}

export const useConnectionHealth = create<ConnectionHealthState>()(() => ({
  state: "disconnected" as ConnectionState,
}));

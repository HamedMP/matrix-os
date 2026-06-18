import { create } from "zustand";

export type ConnectionState = "initializing" | "connected" | "reconnecting" | "disconnected";

interface ConnectionHealthState {
  state: ConnectionState;
}

export const useConnectionHealth = create<ConnectionHealthState>()(() => ({
  state: "initializing" as ConnectionState,
}));

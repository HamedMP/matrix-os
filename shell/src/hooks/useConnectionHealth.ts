import { create } from "zustand";

export type ConnectionState = "initializing" | "connected" | "reconnecting" | "disconnected";

export const RECONNECT_QUIET_WINDOW_MS = 5_000;

interface ConnectionHealthState {
  state: ConnectionState;
  hasConnected: boolean;
  reconnectQuietElapsed: boolean;
}

export const useConnectionHealth = create<ConnectionHealthState>()(() => ({
  state: "initializing" as ConnectionState,
  hasConnected: false,
  reconnectQuietElapsed: false,
}));

let reconnectQuietTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconnectQuietTimer() {
  if (reconnectQuietTimer) {
    clearTimeout(reconnectQuietTimer);
    reconnectQuietTimer = null;
  }
}

export function setConnectionHealthState(state: ConnectionState) {
  clearReconnectQuietTimer();
  const current = useConnectionHealth.getState();
  const next = {
    state,
    hasConnected: current.hasConnected || state === "connected",
    reconnectQuietElapsed: false,
  };
  useConnectionHealth.setState(next);

  if (state !== "reconnecting" || !next.hasConnected) return;
  reconnectQuietTimer = setTimeout(() => {
    reconnectQuietTimer = null;
    const latest = useConnectionHealth.getState();
    if (latest.state === "reconnecting" && latest.hasConnected) {
      useConnectionHealth.setState({ reconnectQuietElapsed: true });
    }
  }, RECONNECT_QUIET_WINDOW_MS);
}

export function resetConnectionHealthState() {
  clearReconnectQuietTimer();
  useConnectionHealth.setState({
    state: "initializing",
    hasConnected: false,
    reconnectQuietElapsed: false,
  });
}

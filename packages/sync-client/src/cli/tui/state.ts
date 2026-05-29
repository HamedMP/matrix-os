import type { TuiStatusSnapshot } from "./status.js";

export type TuiView = "home" | "help" | "sessions";

export interface TuiState {
  activeView: TuiView;
  snapshot: TuiStatusSnapshot | null;
  refreshing: boolean;
  safeError?: string;
}

export function createInitialTuiState(): TuiState {
  return { activeView: "home", snapshot: null, refreshing: false };
}

export function reduceTuiState(state: TuiState, event: { type: "refresh:start" } | { type: "refresh:done"; snapshot: TuiStatusSnapshot } | { type: "view"; view: TuiView }): TuiState {
  switch (event.type) {
    case "refresh:start":
      return { ...state, refreshing: true };
    case "refresh:done":
      return { ...state, refreshing: false, snapshot: event.snapshot };
    case "view":
      return { ...state, activeView: event.view };
  }
}


export function refreshAfterSetupAction(state: TuiState): TuiState {
  return { ...state, refreshing: true, safeError: undefined };
}

export function completeSetupRefresh(state: TuiState, snapshot: TuiStatusSnapshot): TuiState {
  return { ...state, refreshing: false, snapshot, activeView: "home" };
}

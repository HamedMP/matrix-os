export type HomeMirrorReadinessState =
  | "disabled"
  | "starting"
  | "ready"
  | "failed";

export interface HomeMirrorReadinessStatus {
  state: HomeMirrorReadinessState;
}

export interface HomeMirrorReadiness {
  getStatus(): HomeMirrorReadinessStatus;
  markReady(): void;
  markFailed(): void;
}

export function createHomeMirrorReadiness(enabled: boolean): HomeMirrorReadiness {
  let state: HomeMirrorReadinessState = enabled ? "starting" : "disabled";

  return {
    getStatus: () => ({ state }),
    markReady: () => {
      state = "ready";
    },
    markFailed: () => {
      state = "failed";
    },
  };
}

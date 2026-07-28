export interface FocusedPaneRuntimeObservation {
  cwd: string | null;
  command: string | null;
  observed: boolean;
}

export const UNAVAILABLE_FOCUSED_PANE_RUNTIME: FocusedPaneRuntimeObservation = {
  cwd: null,
  command: null,
  observed: false,
};

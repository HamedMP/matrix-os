export interface FocusedPaneRuntimeObservation {
  cwd: string | null;
  command: string | null;
  /** Title emitted by the active terminal application, when available. */
  title?: string;
  observed: boolean;
}

export const UNAVAILABLE_FOCUSED_PANE_RUNTIME: FocusedPaneRuntimeObservation = {
  cwd: null,
  command: null,
  observed: false,
};

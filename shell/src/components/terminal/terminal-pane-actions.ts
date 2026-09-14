import type { TerminalPaneAction } from "@matrix-os/contracts";

const TERMINAL_PANE_ACTION_EVENT = "matrix:terminal-pane-action";
interface PaneActionDetail { paneId: string; action: TerminalPaneAction }

/** Existing layout controls address a mounted renderer; it owns connection gating. */
export function dispatchTerminalPaneAction(paneId: string, action: TerminalPaneAction): void {
  window.dispatchEvent(new CustomEvent<PaneActionDetail>(TERMINAL_PANE_ACTION_EVENT, { detail: { paneId, action } }));
}

export function listenTerminalPaneActions(paneId: string, run: (action: TerminalPaneAction) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PaneActionDetail>).detail;
    if (detail?.paneId === paneId) run(detail.action);
  };
  window.addEventListener(TERMINAL_PANE_ACTION_EVENT, listener);
  return () => window.removeEventListener(TERMINAL_PANE_ACTION_EVENT, listener);
}

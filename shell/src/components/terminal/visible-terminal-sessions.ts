/**
 * Terminal tabs the person can see right now: panes rendered on screen in a
 * visible, focused document. A minimized window or another app in front hides them.
 */
export function visibleTerminalSessions(root: Document | undefined = typeof document === "undefined" ? undefined : document): Set<string> {
  const seen = new Set<string>();
  if (!root || root.visibilityState !== "visible" || !root.hasFocus()) return seen;
  for (const element of root.querySelectorAll<HTMLElement>("[data-terminal-session]")) {
    const session = element.dataset.terminalSession;
    const rect = element.getBoundingClientRect();
    // A hidden element (display: none, a minimized window) has an empty rect anyway.
    const shown = typeof element.checkVisibility === "function" ? element.checkVisibility() : true;
    if (session && shown && rect.width > 0 && rect.height > 0) seen.add(session);
  }
  return seen;
}

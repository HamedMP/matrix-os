/**
 * Terminal tabs the person can see right now: panes marked `data-terminal-session`
 * rendered on screen in a visible, focused document. A minimized window, another
 * app in front, or a Web Canvas pane panned out of the viewport hides them.
 */
export function visibleTerminalSessions(root: Document | undefined = typeof document === "undefined" ? undefined : document): Set<string> {
  const seen = new Set<string>();
  if (!root || root.visibilityState !== "visible" || !root.hasFocus()) return seen;
  const view = viewportSize(root);
  for (const element of root.querySelectorAll<HTMLElement>("[data-terminal-session]")) {
    const session = element.dataset.terminalSession;
    const rect = element.getBoundingClientRect();
    // A hidden element (display: none, a minimized window) has an empty rect anyway.
    const shown = typeof element.checkVisibility === "function" ? element.checkVisibility() : true;
    if (session && shown && intersectsViewport(rect, view)) seen.add(session);
  }
  return seen;
}

function viewportSize(root: Document): { width: number; height: number } {
  const win = root.defaultView;
  const html = root.documentElement;
  return {
    width: win?.innerWidth || html?.clientWidth || 0,
    height: win?.innerHeight || html?.clientHeight || 0,
  };
}

/** True when the rect overlaps the viewport by a positive area. */
function intersectsViewport(rect: DOMRect, view: { width: number; height: number }): boolean {
  const width = Math.min(rect.right, view.width) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, view.height) - Math.max(rect.top, 0);
  return rect.width > 0 && rect.height > 0 && width > 0 && height > 0;
}

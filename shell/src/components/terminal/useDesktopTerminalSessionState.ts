import { useCallback, useState } from "react";

/** Presentation from the sidebar's canonical inventory, scoped to its focused pane. */
export interface DesktopTerminalSessionState {
  count: number;
  ready: boolean;
  sessionId?: string | null;
  name?: string;
}

export function useDesktopTerminalSessionState() {
  const [state, setState] = useState<DesktopTerminalSessionState>({ count: 0, ready: false });
  // Inventory (count/ready) and the focused pane's heading arrive as separate partial
  // reports, so a heading change cannot replay a stale count over a just-created session.
  const update = useCallback((patch: Partial<DesktopTerminalSessionState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      return current.count === next.count && current.ready === next.ready
        && current.sessionId === next.sessionId && current.name === next.name ? current : next;
    });
  }, []);
  return [state, update] as const;
}

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
  const update = useCallback((next: DesktopTerminalSessionState) => {
    setState((current) => current.count === next.count && current.ready === next.ready
      && current.sessionId === next.sessionId && current.name === next.name ? current : next);
  }, []);
  return [state, update] as const;
}

import { useEffect } from "react";

/** The sandbox sends only a fixed boolean; no user input crosses this bridge. */
export function useWorkspaceCloseGuard(dirty: boolean): void {
  useEffect(() => {
    window.parent.postMessage({ type: "matrix-os:utilities-workspace-state", app: "utilities", dirty }, "*");
  }, [dirty]);
}

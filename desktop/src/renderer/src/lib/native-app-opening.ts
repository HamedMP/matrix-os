import { onEvent } from "./operator";
import { useConnection } from "../stores/connection";
import { useTabs } from "../stores/tabs";
import { useDesktopSurfaces } from "../stores/desktop-surfaces";

/** One listener for every native OS view; ordinary app tabs own embed launching. */
export function wireNativeAppOpening(): () => void {
  return onEvent("app:open", (request) => {
    const current = useConnection.getState();
    if (current.status !== "signed-in" || request.runtimeSlot !== current.runtimeSlot
      || request.authGeneration !== current.authGeneration) return;
    const tabId = useTabs.getState().openTab({ kind: "app", slug: request.slug, title: request.name, appIdentity: request.appIdentity });
    // Opening an existing minimized/closed tab also restores its presentation.
    // New surfaces remain owned by the shell's normal tab reconciliation.
    useDesktopSurfaces.getState().activateSurface(tabId);
  });
}

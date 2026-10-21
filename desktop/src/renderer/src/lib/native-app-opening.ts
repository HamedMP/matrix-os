import { onEvent } from "./operator";
import { useConnection } from "../stores/connection";
import { useTabs } from "../stores/tabs";

/** One listener for every native OS view; ordinary app tabs own embed launching. */
export function wireNativeAppOpening(): () => void {
  return onEvent("app:open", (request) => {
    const current = useConnection.getState();
    if (current.status !== "signed-in" || request.runtimeSlot !== current.runtimeSlot
      || request.authGeneration !== current.authGeneration) return;
    useTabs.getState().openTab({ kind: "app", slug: request.slug, title: request.name, appIdentity: request.appIdentity });
  });
}

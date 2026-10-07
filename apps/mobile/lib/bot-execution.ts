import { useState } from "react";
import { botExecutionPresentation, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { NativeBotChatSnapshot } from "./requests/bots";

/** Request-scoped consent never follows the owner across Chat or revision changes. */
export function useNativeBotExecution(snapshot: NativeBotChatSnapshot | null, catalog: CanonicalProviderCatalog | undefined | null,
  scope: string, request: string) {
  const presentation = snapshot?.selection ? botExecutionPresentation({ recipeRef: snapshot.recipeRef, selection: snapshot.selection }, catalog) : null;
  const instance = catalog?.instances.find(candidate => candidate.id === presentation?.selection.instanceId);
  const supportsFullAccess = presentation?.kind === "custom" && presentation.available
    && Boolean(instance?.supports.permissionModes.includes("full_access"));
  const key = JSON.stringify([scope, snapshot?.agentId, snapshot?.revision, request,
    presentation?.selection, presentation?.permissionMode, supportsFullAccess]);
  const [consent, setConsent] = useState<string | null>(null);
  if (consent && consent !== key) setConsent(null);
  const confirmed = supportsFullAccess && consent === key;
  return { presentation, supportsFullAccess, confirmed, confirm: (value: boolean) => setConsent(value && supportsFullAccess ? key : null),
    permissionMode: confirmed ? "full_access" : presentation?.permissionMode,
    reset: () => setConsent(null) };
}

import { useState } from "react";
import { botExecutionPresentation, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { NativeBotChatSnapshot } from "./requests/bots";

/** Request-scoped consent never follows the owner across Chat or revision changes. */
export function useNativeBotExecution(snapshot: NativeBotChatSnapshot | null, catalog: CanonicalProviderCatalog | undefined | null,
  scope: string, request: string) {
  const presentation = snapshot?.selection ? botExecutionPresentation({ recipeRef: snapshot.recipeRef, selection: snapshot.selection }, catalog) : null;
  const key = JSON.stringify([scope, snapshot?.agentId, snapshot?.revision, request]);
  const [consent, setConsent] = useState<string | null>(null);
  if (consent && consent !== key) setConsent(null);
  const confirmed = consent === key;
  return { presentation, confirmed, confirm: (value: boolean) => setConsent(value ? key : null),
    permissionMode: presentation?.kind === "custom" && confirmed ? "full_access" : presentation?.permissionMode,
    reset: () => setConsent(null) };
}

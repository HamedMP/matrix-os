import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { failClosedProviderCatalog } from "./provider-catalog-client";
import { desktopProviderCatalogCache, observeDesktopProviderCatalog } from "./provider-catalog-coordinator";
export { failClosedProviderCatalog, fetchCanonicalProviderCatalog } from "./provider-catalog-client";

export function useChatProviderCatalog(
  fallback: CanonicalProviderCatalog,
  options: { api?: Pick<ApiClient, "get"> | null; active?: boolean } = {},
) {
  const connectionApi = useConnection((state) => state.api);
  const connectionStatus = useConnection((state) => state.status);
  const identityKey = useConnection(desktopProviderIdentityKey);
  const generation = useConnection((state) => state.providerCatalogGeneration);
  const api = options.api === undefined ? connectionApi : options.api;
  const active = options.active ?? true;
  const snapshot = useSyncExternalStore(desktopProviderCatalogCache.subscribe, desktopProviderCatalogCache.getSnapshot);
  // Visibility is presentation only. Root prewarm/schedule and cache lifetime do
  // not depend on whether an individual consumer is mounted or active.
  useEffect(() => {
    if (active && api) observeDesktopProviderCatalog(options.api);
  }, [active, api, identityKey, generation]);
  const currentScope = snapshot.identityKey === identityKey && connectionStatus !== "signed-out" && Boolean(api);
  const currentGeneration = currentScope && snapshot.generation === generation;
  const retained = currentScope ? snapshot.catalog : null;
  const authoritySuspended = Boolean(retained && (!currentGeneration || snapshot.authoritySuspended));
  const catalog = useMemo(() => retained
    ? authoritySuspended ? failClosedProviderCatalog(retained, currentGeneration ? snapshot.suspendedInstanceIds : null) : retained
    : failClosedProviderCatalog(fallback), [fallback, retained, authoritySuspended, currentGeneration, snapshot.suspendedInstanceIds]);
  const initialLoading = !retained && active && connectionStatus !== "signed-out"
    && (Boolean(api) ? !currentGeneration || snapshot.refreshing : connectionStatus === "loading");
  const status: "fallback" | "loading" | "ready" | "error" = initialLoading ? "loading"
    : currentScope ? snapshot.refreshError ? "error" : retained ? "ready" : "fallback" : "fallback";
  return { catalog, status, initialLoading, refreshing: currentScope && snapshot.refreshing,
    lastSuccessAt: currentScope ? snapshot.lastSuccessAt : null,
    refreshError: currentScope ? snapshot.refreshError : null, authoritySuspended,
    hasTrustedCatalog: Boolean(retained && currentGeneration && !snapshot.authoritySuspended),
    refresh: desktopProviderCatalogCache.refresh };
}

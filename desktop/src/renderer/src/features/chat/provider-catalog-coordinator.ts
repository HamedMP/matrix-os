import type { ApiClient } from "../../lib/api";
import { desktopQueryClient } from "../../lib/query-client";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import { ProviderCatalogCache } from "./provider-catalog-cache";

export const desktopProviderCatalogCache = new ProviderCatalogCache(desktopQueryClient);
let cleanup: (() => void) | null = null;
let appOwned = false;
let standaloneApi: Pick<ApiClient, "get"> | null = null;

function reconcile(): void {
  const current = useConnection.getState();
  const api = current.status === "signed-out" ? null : current.api ?? (appOwned ? null : standaloneApi);
  desktopProviderCatalogCache.observe(api && typeof api.get === "function" ? {
    identityKey: desktopProviderIdentityKey(current), generation: current.providerCatalogGeneration, api,
    affectedInstanceIds: current.providerCatalogAffectedInstanceIds,
  } : null);
}

function start(): void {
  if (cleanup) return;
  desktopProviderCatalogCache.setOnline(navigator.onLine);
  const unsubscribe = useConnection.subscribe(reconcile);
  const online = () => desktopProviderCatalogCache.setOnline(true);
  const offline = () => desktopProviderCatalogCache.setOnline(false);
  window.addEventListener("online", online);
  window.addEventListener("offline", offline);
  cleanup = () => {
    unsubscribe();
    window.removeEventListener("online", online);
    window.removeEventListener("offline", offline);
  };
}

/** App owns prewarm/scheduling even while no Chat exists. */
export function startDesktopProviderCatalogCoordinator(): () => void {
  appOwned = true;
  standaloneApi = null;
  start();
  reconcile();
  return stopDesktopProviderCatalogCoordinator;
}

export function stopDesktopProviderCatalogCoordinator(): void {
  cleanup?.();
  cleanup = null;
  appOwned = false;
  standaloneApi = null;
  desktopProviderCatalogCache.clear();
}

/** Supports standalone Chat hosts with an injected transport; never owns teardown. */
export function observeDesktopProviderCatalog(api?: Pick<ApiClient, "get"> | null): void {
  if (!appOwned && api) standaloneApi = api;
  start();
  reconcile();
}
